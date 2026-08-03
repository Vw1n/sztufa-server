import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { BackupMetadata } from './backup.types';
import { BackupScope } from './backup-scope.service';

/**
 * R2 对象存储基础设施服务。
 * 只负责对象存储的原子操作：持有 S3Client、key/prefix 安全校验、put/get/list/head/copy/delete、
 * presign、流式上传与取消。
 * 不包含备份完整性验证等备份领域逻辑（见 BackupVerificationService）。
 */
@Injectable()
export class BackupObjectStoreService {
  readonly s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });

  private get bucket(): string {
    return process.env.R2_BUCKET_NAME || '';
  }

  validateBackupKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new BadRequestException('备份文件 Key 不能为空');
    }
    if (key.includes('..') || key.includes('\\') || key.startsWith('/')) {
      throw new BadRequestException('非法的备份 Key 路径');
    }
    if (
      !key.startsWith('private-backups/database/') ||
      (!key.endsWith('.json') && !key.endsWith('.json.gz'))
    ) {
      throw new BadRequestException(
        '备份 Key 必须位于 private-backups/database/ 目录且为 .json 或 .json.gz 格式',
      );
    }
  }

  async listObjectsWithPrefix(prefix: string): Promise<any[]> {
    const allFiles: any[] = [];
    let continuationToken: string | undefined = undefined;
    let isTruncated = true;
    let pageCount = 0;
    const maxPages = 100;
    const seenTokens = new Set<string>();

    try {
      while (isTruncated) {
        if (pageCount >= maxPages) {
          throw new ServiceUnavailableException(`拉取 ${prefix} 超出最大允许页数限制`);
        }

        pageCount++;
        const command: ListObjectsV2Command = new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const response = await this.s3Client.send(command);
        if (response?.Contents && response.Contents.length > 0) {
          allFiles.push(...response.Contents);
        }

        isTruncated = !!response?.IsTruncated;
        const nextToken = response?.NextContinuationToken;

        if (isTruncated) {
          if (!nextToken || seenTokens.has(nextToken)) {
            throw new ServiceUnavailableException(
              `R2 列表分页令牌失效或遭遇循环引用 (${prefix})，拒绝继续执行`,
            );
          }
          seenTokens.add(nextToken);
        }

        continuationToken = nextToken;
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      console.error(`获取 R2 前缀 ${prefix} 备份列表失败:`, err);
      throw new ServiceUnavailableException('无法从对象存储获取备份文件列表');
    }

    return allFiles;
  }

  async listBackups(options?: { includeUploads?: boolean }): Promise<BackupMetadata[]> {
    const databaseFiles = await this.listObjectsWithPrefix('private-backups/database/');
    let uploadFiles: any[] = [];
    if (options?.includeUploads) {
      uploadFiles = await this.listObjectsWithPrefix('private-backups/uploads/');
    }

    const allFiles = [...databaseFiles, ...uploadFiles];

    const result = allFiles
      .filter((file) => file.Key && (file.Key.endsWith('.json') || file.Key.endsWith('.json.gz')))
      .map((file) => {
        const key = file.Key || '';
        const filename = key.split('/').pop() || '';
        const isGzip = filename.endsWith('.json.gz');
        const isProtected = filename.includes('_protected');

        let scope: BackupScope = 'full';
        let seasonId: string | undefined = undefined;

        if (key.includes('/seasons/')) {
          scope = 'season';
          const parts = key.split('/');
          const sIdx = parts.indexOf('seasons');
          if (sIdx !== -1 && parts.length > sIdx + 1) {
            seasonId = parts[sIdx + 1];
          }
        }

        let purpose = 'manual';
        if (key.startsWith('private-backups/uploads/')) {
          purpose = 'uploaded';
        } else if (filename.includes('_pre-restore') || filename.includes('pre-restore-auto-')) {
          purpose = 'pre-restore';
        } else if (filename.includes('_uploaded')) {
          purpose = 'uploaded';
        } else if (filename.includes('_scheduled')) {
          purpose = 'scheduled';
        }

        return {
          key,
          filename,
          size: file.Size || 0,
          lastModified: file.LastModified,
          formatVersion: isGzip ? '3.0' : '2.0',
          compressed: isGzip,
          purpose,
          protected: isProtected,
          validated: false,
          scope,
          seasonId,
        };
      })
      .sort((a, b) => {
        const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return timeB - timeA;
      });

    return result;
  }

  async getObjectBody(key: string, notFoundMessage?: string): Promise<Readable> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return response.Body as Readable;
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof ServiceUnavailableException) {
        throw err;
      }
      const isNotFound =
        err?.name === 'NoSuchKey' ||
        err?.name === 'NotFound' ||
        err?.code === 'NoSuchKey' ||
        err?.code === 'NotFound' ||
        err?.$metadata?.httpStatusCode === 404;

      if (isNotFound) {
        throw new BadRequestException(notFoundMessage || `指定的备份文件不存在或无法读取: ${key}`);
      }
      console.error(`读取 R2 对象 ${key} 发生存储基础设施异常:`, err);
      throw new ServiceUnavailableException(`对象存储服务异常，无法读取备份文件: ${key}`);
    }
  }

  async headObject(key: string): Promise<number> {
    try {
      const response = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return response?.ContentLength ?? -1;
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof ServiceUnavailableException) {
        throw err;
      }
      const isNotFound =
        err?.name === 'NoSuchKey' ||
        err?.name === 'NotFound' ||
        err?.code === 'NoSuchKey' ||
        err?.code === 'NotFound' ||
        err?.$metadata?.httpStatusCode === 404;

      if (isNotFound) {
        throw new BadRequestException(`未在云端找到指定的备份文件: ${key}`);
      }
      console.error(`Head R2 对象 ${key} 发生存储基础设施异常:`, err);
      throw new ServiceUnavailableException(`对象存储服务异常，无法获取备份元数据: ${key}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async copyObject(
    sourceKey: string,
    targetKey: string,
    contentType: string,
    contentDisposition: string,
  ): Promise<void> {
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: targetKey,
        ContentType: contentType,
        ContentDisposition: contentDisposition,
        MetadataDirective: 'REPLACE',
      }),
    );
  }

  /**
   * 创建支持取消的流式上传任务（V3 GZIP 备份专用）
   */
  createUpload(key: string, filename: string, body: Readable, signal?: AbortSignal): Upload {
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
        ContentDisposition: `attachment; filename="${filename}"`,
      },
    });

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          upload.abort().catch(() => {});
        },
        { once: true },
      );
    }

    return upload;
  }

  async presignGetUrl(key: string, expiresIn: number): Promise<string> {
    this.validateBackupKey(key);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return await getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async presignPutUrl(key: string, contentType: string, expiresIn: number): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    return await getSignedUrl(this.s3Client, command, {
      expiresIn,
    });
  }
}
