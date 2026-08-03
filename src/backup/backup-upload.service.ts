import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupMetadata, UploadInitResult, UploadTokenPayload } from './backup.types';

const DEFAULT_BACKUP_UPLOAD_TTL_SECONDS = 60 * 60;
const MIN_BACKUP_UPLOAD_TTL_SECONDS = 10 * 60;
const MAX_BACKUP_UPLOAD_TTL_SECONDS = 6 * 60 * 60;

/**
 * 备份直传服务（安全敏感链路）。
 * 负责：生成与验证无状态 HMAC upload token、限制 TTL 与文件大小、生成临时上传 URL、
 * 服务端重算 SHA-256、验证上传内容、将临时对象提升为正式备份对象、
 * 以及失败/过期场景下清理临时对象。
 */
@Injectable()
export class BackupUploadService {
  constructor(
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private getHmacSecret(): Buffer {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new ServiceUnavailableException('系统关键服务异常：未配置 JWT_SECRET 环境变量');
    }
    return crypto
      .createHmac('sha256', jwtSecret)
      .update('antigravity-backup-upload-token')
      .digest();
  }

  private getUploadTtlSeconds(): number {
    const configured = Number.parseInt(process.env.BACKUP_UPLOAD_TOKEN_TTL_SECONDS || '', 10);
    if (!Number.isFinite(configured) || configured <= 0) {
      return DEFAULT_BACKUP_UPLOAD_TTL_SECONDS;
    }
    return Math.min(
      Math.max(configured, MIN_BACKUP_UPLOAD_TTL_SECONDS),
      MAX_BACKUP_UPLOAD_TTL_SECONDS,
    );
  }

  private signUploadToken(payloadBase64: string): string {
    const hmacSecret = this.getHmacSecret();
    return crypto.createHmac('sha256', hmacSecret).update(payloadBase64).digest('hex');
  }

  async initUpload(
    userId: string,
    username: string,
    filename: string,
    size: number,
    fileSha256: string,
  ): Promise<UploadInitResult> {
    if (!filename || (!filename.endsWith('.json') && !filename.endsWith('.json.gz'))) {
      throw new BadRequestException('上传备份文件格式必须为 .json 或 .json.gz');
    }

    const isGzip = filename.endsWith('.json.gz');
    const maxAllowedBytes = isGzip
      ? parseInt(process.env.BACKUP_MAX_COMPRESSED_BYTES || '104857600', 10)
      : parseInt(process.env.BACKUP_MAX_UNCOMPRESSED_BYTES || '209715200', 10);

    if (typeof size !== 'number' || size <= 0 || size > maxAllowedBytes) {
      throw new BadRequestException(`文件大小必须在 1 字节到 ${maxAllowedBytes} 字节之间`);
    }

    if (!fileSha256 || !/^[a-fA-F0-9]{64}$/.test(fileSha256)) {
      throw new BadRequestException('非法的 SHA-256 哈希值格式');
    }

    const ext = isGzip ? '.json.gz' : '.json';
    const contentType = isGzip ? 'application/gzip' : 'application/json';
    const key = `private-backups/uploads/upload_${Date.now()}_${crypto.randomUUID()}${ext}`;
    const uploadTtlSeconds = this.getUploadTtlSeconds();
    const expiresAt = Date.now() + uploadTtlSeconds * 1000;

    const payload: UploadTokenPayload = {
      key,
      size,
      fileSha256: fileSha256.toLowerCase(),
      userId,
      expiresAt,
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.signUploadToken(payloadBase64);
    const uploadToken = `${payloadBase64}.${signature}`;

    const uploadUrl = await this.objectStore.presignPutUrl(key, contentType, uploadTtlSeconds);

    await this.auditLogService.log(
      username,
      'INIT_BACKUP_UPLOAD',
      `初始化直传备份文件: ${filename} (${size} 字节), 目标 Key: ${key}`,
    );

    return {
      uploadToken,
      uploadUrl,
      key,
      expiresIn: uploadTtlSeconds,
      requiredHeaders: {
        'Content-Type': contentType,
      },
    };
  }

  async completeUpload(
    userId: string,
    username: string,
    uploadToken: string,
  ): Promise<BackupMetadata> {
    if (!uploadToken || typeof uploadToken !== 'string') {
      throw new BadRequestException('上传 Token 不能为空');
    }

    const parts = uploadToken.split('.');
    if (parts.length !== 2) {
      throw new BadRequestException('非法的上传 Token 格式');
    }

    const [payloadBase64, sigHex] = parts;
    const expectedSigHex = this.signUploadToken(payloadBase64);

    const sigBuf = Buffer.from(sigHex, 'utf8');
    const expectedBuf = Buffer.from(expectedSigHex, 'utf8');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      throw new BadRequestException('上传 Token 签名不匹配或已被篡改');
    }

    let payload: UploadTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('上传 Token 载荷解析失败');
    }

    if (
      !payload ||
      typeof payload.key !== 'string' ||
      typeof payload.size !== 'number' ||
      typeof payload.fileSha256 !== 'string' ||
      typeof payload.userId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      !/^[a-fA-F0-9]{64}$/.test(payload.fileSha256)
    ) {
      throw new BadRequestException('上传 Token 载荷结构非法');
    }

    if (payload.userId !== userId) {
      throw new BadRequestException('上传 Token 不属于当前发起用户');
    }

    if (Date.now() > payload.expiresAt) {
      await this.objectStore.deleteObject(payload.key).catch(() => {});
      throw new BadRequestException('上传 Token 已过期，请重新发起直传');
    }

    if (!payload.key.startsWith('private-backups/uploads/')) {
      throw new BadRequestException('非法的临时上传文件路径');
    }

    const contentLength = await this.objectStore.headObject(payload.key);

    if (contentLength !== payload.size) {
      await this.objectStore.deleteObject(payload.key).catch(() => {});
      throw new BadRequestException(
        `云端文件大小 (${contentLength} 字节) 与预设大小 (${payload.size} 字节) 不一致`,
      );
    }

    const body = await this.objectStore.getObjectBody(payload.key, '读取上传临时文件流失败');

    let parseResult: import('./backup-serializer').ParseStreamResult | null = null;
    try {
      parseResult = await this.verificationService.parseAndValidate(body, payload.fileSha256);
    } catch (validationErr) {
      if (parseResult) parseResult.cleanup();
      await this.objectStore.deleteObject(payload.key).catch(() => {});
      throw validationErr;
    } finally {
      if (parseResult) parseResult.cleanup();
    }

    const isGzip = payload.key.endsWith('.json.gz');
    const ext = isGzip ? '.json.gz' : '.json';
    const targetFilename = `backup_${Date.now()}_uploaded${ext}`;
    const targetKey = `private-backups/database/full/${targetFilename}`;

    try {
      await this.objectStore.copyObject(
        payload.key,
        targetKey,
        isGzip ? 'application/gzip' : 'application/json',
        `attachment; filename="${targetFilename}"`,
      );
      await this.objectStore.deleteObject(payload.key);
    } catch (err) {
      console.error('转存备份文件失败:', err);
      throw new ServiceUnavailableException('无法完成上传备份文件的持久化存储');
    }

    await this.auditLogService.log(
      username,
      'COMPLETE_BACKUP_UPLOAD',
      `完成本地备份直传及全量合规校验，转存备份Key: ${targetKey}`,
    );

    return {
      key: targetKey,
      filename: targetFilename,
      size: payload.size,
      lastModified: new Date(),
      formatVersion: isGzip ? '3.0' : '2.0',
      compressed: isGzip,
      purpose: 'uploaded',
      validated: true,
      scope: 'full',
    };
  }
}
