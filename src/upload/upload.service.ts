import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
  ForbiddenException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import * as crypto from 'crypto';

import { PrismaService } from '../prisma/prisma.service';

export interface PromotedAsset {
  originalUrl: string;
  formalUrl: string;
  formalKey: string;
  oldKey: string;
  isPromoted: boolean;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3Client: S3Client;

  getUserTempPrefix(username: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(username || 'anonymous')
      .digest('hex')
      .slice(0, 12);
    return `temp/user_${hash}/`;
  }

  async uploadImage(file: Express.Multer.File, username: string = 'anonymous'): Promise<string> {
    this.validateImageMagicBytes(file.buffer);
    let compressedBuffer: Buffer;
    try {
      compressedBuffer = await sharp(file.buffer)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (error) {
      this.logger.error(
        `图片处理失败: name=${file.originalname}, type=${file.mimetype}, size=${file.size}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new UnprocessableEntityException('图片无法解析或格式不受支持，请更换图片后重试');
    }

    const prefix = this.getUserTempPrefix(username);
    const fileKey = `${prefix}${Date.now()}-${Math.random().toString(36).substring(2, 8)}.webp`;
    return this.uploadBuffer(compressedBuffer, fileKey, 'image/webp');
  }

  async promoteTempAsset(
    urlOrKey: string | null | undefined,
    targetSubpath: string,
    username: string,
    userCtx?: { role?: string },
  ): Promise<PromotedAsset | null> {
    if (!urlOrKey || typeof urlOrKey !== 'string') return null;
    const cleanUrlOrKey = urlOrKey.trim();
    if (!cleanUrlOrKey) return null;

    const key = this.extractKeyFromUrl(cleanUrlOrKey);
    if (!key.startsWith('temp/')) {
      return {
        originalUrl: cleanUrlOrKey,
        formalUrl: cleanUrlOrKey,
        formalKey: key,
        oldKey: key,
        isPromoted: false,
      };
    }

    const userPrefix = this.getUserTempPrefix(username);
    const isUserTemp = key.startsWith(userPrefix);
    const isLegacyAdminTemp =
      key.startsWith('temp/') &&
      !key.startsWith('temp/user_') &&
      (username === 'admin' || userCtx?.role === 'super_admin');
    const isSuperAdmin = userCtx?.role === 'super_admin';

    if (!isUserTemp && !isLegacyAdminTemp && !isSuperAdmin) {
      this.logger.warn(`拦截越权转存临时图片: username=${username}, key=${key}`);
      throw new ForbiddenException('您没有权限使用该临时图片资源');
    }

    const fileName = key.substring(key.lastIndexOf('/') + 1);
    const cleanSubpath = targetSubpath.replace(/^\/+|\/+$/g, '');
    const formalKey = `uploads/${cleanSubpath}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${fileName}`;

    const formalUrl = await this.copyObject(key, formalKey);
    return {
      originalUrl: cleanUrlOrKey,
      formalUrl,
      formalKey,
      oldKey: key,
      isPromoted: true,
    };
  }

  constructor(private readonly prisma: PrismaService) {
    const requiredConfig = [
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET_NAME',
      'R2_PUBLIC_URL',
    ];
    const missingConfig = requiredConfig.filter((key) => !process.env[key]);
    if (missingConfig.length > 0) {
      this.logger.error(`R2 配置缺失: ${missingConfig.join(', ')}`);
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
    });
  }

  getPublicUrl(key: string): string {
    if (!key) return '';
    if (
      key.startsWith('private-') ||
      key.startsWith('private-backups/') ||
      key.startsWith('private-imports/')
    ) {
      throw new UnprocessableEntityException('私有存储对象不能直接生成公网访问 URL');
    }
    const baseUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const cleanKey = key.replace(/^\//, '');
    return `${baseUrl}/${cleanKey}`;
  }

  async createPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 10 * 60,
  ): Promise<string> {
    if (!process.env.R2_BUCKET_NAME || !key) {
      throw new ServiceUnavailableException('图片存储服务配置不完整');
    }

    return getSignedUrl(
      this.s3Client,
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async getObjectBuffer(key: string, maxBytes?: number): Promise<Buffer> {
    if (!process.env.R2_BUCKET_NAME || !key) {
      throw new ServiceUnavailableException('图片存储服务配置不完整');
    }

    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
      if (!response.Body) {
        throw new Error('对象内容为空');
      }
      if (
        maxBytes &&
        typeof response.ContentLength === 'number' &&
        response.ContentLength > maxBytes
      ) {
        throw new UnprocessableEntityException('对象大小超过允许限制');
      }
      const bytes = await response.Body.transformToByteArray();
      if (maxBytes && bytes.byteLength > maxBytes) {
        throw new UnprocessableEntityException('对象大小超过允许限制');
      }
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof UnprocessableEntityException) {
        throw error;
      }
      this.logger.error(
        `S3 getObject 失败: key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('无法读取已上传的 PDF 文件');
    }
  }

  extractKeyFromUrl(urlOrKey: string): string {
    if (!urlOrKey) return '';
    const baseUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (baseUrl && urlOrKey.startsWith(`${baseUrl}/`)) {
      return urlOrKey.substring(baseUrl.length + 1);
    }
    return urlOrKey;
  }

  private validateImageMagicBytes(buffer: Buffer): void {
    if (!buffer || buffer.length < 4) {
      throw new UnprocessableEntityException('上传文件大小过小或已损坏');
    }
    const isPng =
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isGif =
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
    const isWebp =
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';

    if (!isPng && !isJpeg && !isGif && !isWebp) {
      throw new UnprocessableEntityException(
        '不受支持的图片格式，文件头魔数校验失败 (仅支持 PNG, JPEG, GIF, WEBP)',
      );
    }
  }

  async uploadBuffer(buffer: Buffer, key: string, contentType = 'image/webp'): Promise<string> {
    if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
      throw new ServiceUnavailableException('图片存储服务配置不完整');
    }

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      this.logger.error(
        `R2 上传失败: key=${key}, size=${buffer.length}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('图片存储服务暂不可用，请稍后重试');
    }

    return this.getPublicUrl(key);
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<string> {
    if (!process.env.R2_BUCKET_NAME) {
      throw new ServiceUnavailableException('图片存储服务配置不完整');
    }

    const bucket = process.env.R2_BUCKET_NAME;
    try {
      await this.s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${sourceKey}`,
          Key: destinationKey,
        }),
      );
      return this.getPublicUrl(destinationKey);
    } catch (error) {
      this.logger.error(
        `S3 copyObject 失败: sourceKey=${sourceKey}, destKey=${destinationKey}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('图片转存失败');
    }
  }

  async deleteObject(key: string): Promise<void> {
    if (!process.env.R2_BUCKET_NAME || !key) return;

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
    } catch (error) {
      this.logger.error(
        `S3 deleteObject 失败: key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(`S3 deleteObject 失败: ${key}`);
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (!process.env.R2_BUCKET_NAME || !keys || keys.length === 0) return;

    const validKeys = keys.filter(Boolean);
    if (validKeys.length === 0) return;

    try {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Delete: {
            Objects: validKeys.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `S3 deleteObjects 批量删除失败: count=${validKeys.length}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(`S3 deleteObjects 批量删除失败`);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (!process.env.R2_BUCKET_NAME || !prefix) return;

    let continuationToken: string | undefined = undefined;

    try {
      do {
        const listResponse = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        const objects = (listResponse.Contents || [])
          .map((obj) => obj.Key)
          .filter((k): k is string => Boolean(k));

        if (objects.length > 0) {
          await this.deleteObjects(objects);
        }

        continuationToken = listResponse.IsTruncated
          ? listResponse.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (error) {
      this.logger.error(
        `S3 deleteByPrefix 失败: prefix=${prefix}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(`S3 deleteByPrefix 物理清理失败: prefix=${prefix}`);
    }
  }

  async headObject(key: string): Promise<boolean> {
    if (!process.env.R2_BUCKET_NAME || !key) return false;

    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async cleanupTempKeys(
    keys: string[],
    username: string,
    options?: { excludedDraftId?: string },
  ): Promise<{ cleanedCount: number }> {
    if (!keys || keys.length === 0) return { cleanedCount: 0 };
    let cleanedCount = 0;
    const userPrefix = this.getUserTempPrefix(username);

    for (const rawUrl of keys) {
      const key = this.extractKeyFromUrl(rawUrl);
      if (!key || key.startsWith('http://') || key.startsWith('https://')) {
        continue;
      }

      // 所有权校验：Key 必须属于当前用户的临时目录 (或通用 temp/ 前缀且当前为系统管理员)
      // 注意：temp/user_ 前缀的路径是用户隔离目录，不受 legacy admin 规则豁免
      const isUserTemp = key.startsWith(userPrefix);
      const isLegacyTemp =
        (key.startsWith('temp/') && !key.startsWith('temp/user_')) ||
        key.startsWith('uploads/players/imports/');
      if (!isUserTemp && !(isLegacyTemp && username === 'admin')) {
        this.logger.warn(`拦截越权物理删除请求: username=${username}, key=${key}`);
        continue;
      }

      const fullUrl = this.getPublicUrl(key);
      const urlCandidates = [key, fullUrl].filter(Boolean);

      const [teamRef, playerRef, profileRef, seasonPlayerRef] = await Promise.all([
        this.prisma.team.findFirst({
          where: {
            OR: [
              { teamLogo: { in: urlCandidates } },
              { homeJersey: { in: urlCandidates } },
              { awayJersey: { in: urlCandidates } },
            ],
          },
        }),
        this.prisma.player.findFirst({
          where: { photo: { in: urlCandidates } },
        }),
        this.prisma.seasonTeamProfile.findFirst({
          where: {
            OR: [
              { teamLogo: { in: urlCandidates } },
              { homeJersey: { in: urlCandidates } },
              { awayJersey: { in: urlCandidates } },
            ],
          },
        }),
        this.prisma.seasonTeamPlayer.findFirst({
          where: { playerPhoto: { in: urlCandidates } },
        }),
      ]);

      let isReferencedInDrafts = false;
      try {
        const otherDrafts = await this.prisma.adminFormDraft.findMany({
          where: {
            status: { not: 'MATERIALIZED' },
            ...(options?.excludedDraftId ? { id: { not: options.excludedDraftId } } : {}),
          },
          select: { payload: true },
        });
        for (const draft of otherDrafts) {
          if (JSON.stringify(draft.payload).includes(key)) {
            isReferencedInDrafts = true;
            break;
          }
        }
      } catch {}

      if (!teamRef && !playerRef && !profileRef && !seasonPlayerRef && !isReferencedInDrafts) {
        try {
          await this.deleteObject(key);
          cleanedCount++;
        } catch (err) {
          this.logger.warn(`Failed to cleanup temp key=${key}: ${err}`);
        }
      }
    }

    return { cleanedCount };
  }
}
