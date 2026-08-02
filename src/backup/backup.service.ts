import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  MANDATORY_BACKUP_TABLES,
  MandatoryBackupTableName,
  RESTORE_DELETE_ORDER,
  RESTORE_INSERT_ORDER,
  TABLE_METADATA_MAP,
} from './backup-table-registry';
import {
  validateBackupSchemaAndIntegrity,
  validateBackupStreamIntegrity,
  validateForeignKeysFromStaging,
} from './backup-validator';
import {
  createV3BackupStream,
  parseAndValidateBackupStream,
  ParseStreamResult,
} from './backup-serializer';
import { BackupRetentionService, RetentionResult } from './backup-retention.service';
import { BackupScopeService, BackupScope, getSeasonTableWhereClause } from './backup-scope.service';

export { MANDATORY_BACKUP_TABLES, validateBackupSchemaAndIntegrity };

const DEFAULT_BACKUP_UPLOAD_TTL_SECONDS = 60 * 60;
const MIN_BACKUP_UPLOAD_TTL_SECONDS = 10 * 60;
const MAX_BACKUP_UPLOAD_TTL_SECONDS = 6 * 60 * 60;

export interface BackupMetadata {
  key: string;
  filename: string;
  size: number;
  lastModified?: Date;
  formatVersion?: string;
  compressed?: boolean;
  checksum?: string;
  purpose?: string;
  protected?: boolean;
  validated?: boolean;
  scope?: BackupScope;
  seasonId?: string;
}

export interface UploadInitResult {
  uploadToken: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

export interface CreateBackupOptions {
  purpose?: 'manual' | 'scheduled' | 'pre-restore' | 'uploaded';
  protected?: boolean;
  scope?: BackupScope;
  seasonId?: string;
  signal?: AbortSignal;
}

@Injectable()
export class BackupService {
  private s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly retentionService: BackupRetentionService,
    private readonly scopeService: BackupScopeService,
  ) {}

  private validateBackupKey(key: string): void {
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

  async createBackup(username: string, options?: CreateBackupOptions): Promise<BackupMetadata> {
    const purpose = options?.purpose || 'manual';
    const isProtected = !!options?.protected;
    const scope = options?.scope || 'full';
    const pageSize = parseInt(process.env.BACKUP_PAGE_SIZE || '500', 10);

    let seasonInfo: { id: string; name: string } | undefined = undefined;

    if (scope === 'season') {
      if (!options?.seasonId) {
        throw new BadRequestException('分赛季导出必须提供关联的 seasonId');
      }
      const seasonObj = await this.scopeService.validateSeason(options.seasonId);
      seasonInfo = { id: seasonObj.id, name: seasonObj.name };
    }

    const pageIteratorProvider = (tableName: MandatoryBackupTableName) => {
      const meta = TABLE_METADATA_MAP[tableName];
      const prismaDelegate = (this.prisma as any)[meta.prismaDelegateName];

      const whereClause =
        scope === 'season' && options?.seasonId
          ? getSeasonTableWhereClause(tableName, options.seasonId)
          : {};

      return (async function* () {
        let lastId: string | null = null;
        let hasMore = true;

        while (hasMore) {
          if (options?.signal?.aborted) {
            throw new BadRequestException('客户端连接已断开，备份导出取消');
          }

          const findOptions: any = {
            where: whereClause,
            orderBy: { [meta.cursorField]: 'asc' },
            take: pageSize,
          };

          if (scope === 'season' && tableName === 'Player') {
            findOptions.include = {
              suspendedAtMatch: { select: { seasonId: true } },
            };
          }

          if (lastId) {
            findOptions.cursor = { [meta.cursorField]: lastId };
            findOptions.skip = 1;
          }

          const page: any[] = await prismaDelegate.findMany(findOptions);

          if (!page || page.length === 0) {
            hasMore = false;
            break;
          }

          const processedPage = page.map((row: any) => {
            if (scope === 'season' && tableName === 'Player') {
              const { suspendedAtMatch, ...exportRecord } = row;
              if (
                exportRecord.suspendedAtMatchId &&
                suspendedAtMatch?.seasonId !== options?.seasonId
              ) {
                exportRecord.suspendedAtMatchId = null;
              }
              return exportRecord;
            }
            return row;
          });

          yield processedPage;

          lastId = page[page.length - 1][meta.cursorField];
          if (page.length < pageSize) {
            hasMore = false;
          }
        }
      })();
    };

    const createdAtIso = new Date().toISOString();
    const { stream, checksumPromise } = createV3BackupStream(pageIteratorProvider, {
      createdAt: createdAtIso,
      scope,
      season: seasonInfo,
    });

    const protectSuffix = isProtected ? '_protected' : '';
    const filename = `backup_${Date.now()}_${purpose}${protectSuffix}.json.gz`;

    let fileKey = `private-backups/database/full/${filename}`;
    if (scope === 'season' && options?.seasonId) {
      fileKey = `private-backups/database/seasons/${options.seasonId}/${filename}`;
    } else if (purpose === 'pre-restore') {
      fileKey = `private-backups/database/${filename}`;
    }

    const parallelUpload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileKey,
        Body: stream,
        ContentType: 'application/gzip',
        ContentDisposition: `attachment; filename="${filename}"`,
      },
    });

    if (options?.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          parallelUpload.abort().catch(() => {});
        },
        { once: true },
      );
    }

    let checksum = '';
    try {
      await parallelUpload.done();
      checksum = await checksumPromise;
      const verified = await this.verifyBackupIntegrity(fileKey);
      if (!verified) {
        throw new Error(`备份上传后完整性校验失败: ${fileKey}`);
      }
    } catch (err: any) {
      await parallelUpload.abort().catch(() => {});
      try {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileKey,
          }),
        );
      } catch (deleteErr: any) {
        console.error(`[CRITICAL] 备份校验失败且物理删除失败，遗留废弃文件: ${fileKey}`, deleteErr);
      }
      console.error('上传或校验备份文件至 R2 失败:', err);
      if (err instanceof BadRequestException) throw err;
      throw new ServiceUnavailableException('无法将备份文件保存至对象存储');
    }

    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `触发${scope === 'season' ? '分赛季' : '全站'}数据库备份 (V3.0 GZIP)，备份文件: ${fileKey}。`,
    );

    return {
      key: fileKey,
      filename,
      size: 0,
      lastModified: new Date(),
      formatVersion: '3.0',
      compressed: true,
      checksum,
      purpose,
      protected: isProtected,
      validated: true,
      scope,
      seasonId: options?.seasonId,
    };
  }

  private async listObjectsWithPrefix(prefix: string): Promise<any[]> {
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
          Bucket: process.env.R2_BUCKET_NAME,
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

  async getPresignedDownloadUrl(key: string): Promise<string> {
    this.validateBackupKey(key);

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    return await getSignedUrl(this.s3Client, command, { expiresIn: 300 });
  }

  async verifyBackupIntegrity(key: string, integrityMap?: Map<string, boolean>): Promise<boolean> {
    if (integrityMap && integrityMap.has(key)) {
      return integrityMap.get(key)!;
    }

    let parseResult: ParseStreamResult | null = null;
    try {
      const s3Response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
      parseResult = await parseAndValidateBackupStream(s3Response.Body as any);
      validateBackupStreamIntegrity(parseResult);
      await validateForeignKeysFromStaging(parseResult);
      if (integrityMap) integrityMap.set(key, true);
      return true;
    } catch {
      if (integrityMap) integrityMap.set(key, false);
      return false;
    } finally {
      if (parseResult) {
        parseResult.cleanup();
      }
    }
  }

  async restoreBackup(username: string, key: string, confirmText?: string): Promise<string> {
    if (process.env.BACKUP_RESTORE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('备份恢复功能未启用');
    }

    if (confirmText !== 'CONFIRM_RESTORE') {
      throw new BadRequestException(
        '覆盖恢复请求缺少二次确认标识或确认文本错误 (需提交 "CONFIRM_RESTORE")',
      );
    }

    this.validateBackupKey(key);

    let s3Response;
    try {
      s3Response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
    } catch {
      throw new BadRequestException(`指定的备份文件无法读取或不存在: ${key}`);
    }

    let parseResult: ParseStreamResult | null = null;
    try {
      parseResult = await parseAndValidateBackupStream(s3Response.Body as any);
      validateBackupStreamIntegrity(parseResult);
      await validateForeignKeysFromStaging(parseResult);
    } catch (err: any) {
      if (parseResult) parseResult.cleanup();
      throw err;
    }

    if (parseResult.scope === 'season') {
      parseResult.cleanup();
      throw new BadRequestException('分赛季恢复暂未开放，请使用全站灾备恢复');
    }

    let preRestoreSnapshotKey = '';
    try {
      const snapshotMeta = await this.createBackup(username, { purpose: 'pre-restore' });
      preRestoreSnapshotKey = snapshotMeta.key;
    } catch (snapshotErr) {
      parseResult.cleanup();
      throw new ServiceUnavailableException(
        `恢复前自动创建快照失败，已终止恢复操作: ${
          snapshotErr instanceof Error ? snapshotErr.message : '未知错误'
        }`,
      );
    }

    const txTimeout = parseInt(process.env.BACKUP_RESTORE_TX_TIMEOUT_MS || '300000', 10);
    const staging = parseResult.stagingStore;

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
          if (!locked) {
            throw new ConflictException('已有其他进程或节点正在执行数据库恢复操作');
          }

          await tx.match.updateMany({ data: { mvpPlayerId: null } });
          await tx.player.updateMany({ data: { suspendedAtMatchId: null } });
          await tx.user.updateMany({ data: { teamId: null } });

          for (const tableName of RESTORE_DELETE_ORDER) {
            const meta = TABLE_METADATA_MAP[tableName];
            await (tx as any)[meta.prismaDelegateName].deleteMany();
          }

          for (const tableName of RESTORE_INSERT_ORDER) {
            const meta = TABLE_METADATA_MAP[tableName];
            const delegate = (tx as any)[meta.prismaDelegateName];

            for await (const batch of staging.iterateTable(tableName, 500)) {
              if (!batch.length) continue;

              const formattedBatch = batch.map((row: any) => {
                const cleaned = { ...row };
                if (tableName === 'Player') cleaned.suspendedAtMatchId = null;
                if (tableName === 'Match') cleaned.mvpPlayerId = null;
                if (tableName === 'User') cleaned.teamId = null;

                for (const df of meta.dateFields) {
                  if (cleaned[df] !== undefined && cleaned[df] !== null) {
                    cleaned[df] = new Date(cleaned[df]);
                  }
                }
                return cleaned;
              });

              await delegate.createMany({ data: formattedBatch });
            }
          }

          // 修复 Match.mvpPlayerId
          for await (const batch of staging.iterateTable('Match', 500)) {
            for (const m of batch) {
              if (m.mvpPlayerId) {
                await tx.match.update({
                  where: { id: m.id },
                  data: {
                    mvpPlayerId: m.mvpPlayerId,
                    updatedAt: m.updatedAt ? new Date(m.updatedAt) : undefined,
                  },
                });
              }
            }
          }

          // 修复 Player.suspendedAtMatchId
          for await (const batch of staging.iterateTable('Player', 500)) {
            for (const p of batch) {
              if (p.suspendedAtMatchId) {
                await tx.player.update({
                  where: { id: p.id },
                  data: {
                    suspendedAtMatchId: p.suspendedAtMatchId,
                    updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined,
                  },
                });
              }
            }
          }

          // 修复 User.teamId
          for await (const batch of staging.iterateTable('User', 500)) {
            for (const u of batch) {
              if (u.teamId) {
                await tx.user.update({
                  where: { id: u.id },
                  data: {
                    teamId: u.teamId,
                    updatedAt: u.updatedAt ? new Date(u.updatedAt) : undefined,
                  },
                });
              }
            }
          }
        },
        {
          maxWait: 20000,
          timeout: txTimeout,
        },
      );

      await this.auditLogService.log(
        username,
        'RESTORE_BACKUP',
        `从备份 ${key} 成功覆盖还原数据库，前置自动快照: ${preRestoreSnapshotKey}。`,
      );

      return '数据库还原成功';
    } catch (err: any) {
      console.error('还原备份失败:', err);
      if (
        err instanceof BadRequestException ||
        err instanceof ServiceUnavailableException ||
        err instanceof ConflictException
      ) {
        throw err;
      }
      throw new Error(`还原备份失败: ${err?.message || '未知错误'}`);
    } finally {
      if (parseResult) parseResult.cleanup();
    }
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

    const payload = {
      key,
      size,
      fileSha256: fileSha256.toLowerCase(),
      userId,
      expiresAt,
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const hmacSecret = this.getHmacSecret();
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadBase64).digest('hex');
    const uploadToken = `${payloadBase64}.${signature}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: uploadTtlSeconds,
    });

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
    const hmacSecret = this.getHmacSecret();
    const expectedSigHex = crypto
      .createHmac('sha256', hmacSecret)
      .update(payloadBase64)
      .digest('hex');

    const sigBuf = Buffer.from(sigHex, 'utf8');
    const expectedBuf = Buffer.from(expectedSigHex, 'utf8');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      throw new BadRequestException('上传 Token 签名不匹配或已被篡改');
    }

    let payload: any;
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
      await this.s3Client
        .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: payload.key }))
        .catch(() => {});
      throw new BadRequestException('上传 Token 已过期，请重新发起直传');
    }

    if (!payload.key.startsWith('private-backups/uploads/')) {
      throw new BadRequestException('非法的临时上传文件路径');
    }

    let headRes;
    try {
      headRes = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: payload.key,
        }),
      );
    } catch {
      throw new BadRequestException(`未在云端找到指定的临时上传文件: ${payload.key}`);
    }

    if (headRes.ContentLength !== payload.size) {
      await this.s3Client
        .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: payload.key }))
        .catch(() => {});
      throw new BadRequestException(
        `云端文件大小 (${headRes.ContentLength} 字节) 与预设大小 (${payload.size} 字节) 不一致`,
      );
    }

    let getRes;
    try {
      getRes = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: payload.key,
        }),
      );
    } catch {
      throw new BadRequestException('读取上传临时文件流失败');
    }

    let parseResult: ParseStreamResult | null = null;
    try {
      parseResult = await parseAndValidateBackupStream(getRes.Body as any);

      if (parseResult.fileSha256.toLowerCase() !== payload.fileSha256.toLowerCase()) {
        throw new BadRequestException('上传文件哈希与初始化摘要不一致，数据可能已被篡改');
      }

      validateBackupStreamIntegrity(parseResult);
      await validateForeignKeysFromStaging(parseResult);
    } catch (validationErr) {
      if (parseResult) parseResult.cleanup();
      await this.s3Client
        .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: payload.key }))
        .catch(() => {});
      throw validationErr;
    } finally {
      if (parseResult) parseResult.cleanup();
    }

    const isGzip = payload.key.endsWith('.json.gz');
    const ext = isGzip ? '.json.gz' : '.json';
    const targetFilename = `backup_${Date.now()}_uploaded${ext}`;
    const targetKey = `private-backups/database/full/${targetFilename}`;

    try {
      await this.s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          CopySource: `${process.env.R2_BUCKET_NAME}/${payload.key}`,
          Key: targetKey,
          ContentType: isGzip ? 'application/gzip' : 'application/json',
          ContentDisposition: `attachment; filename="${targetFilename}"`,
        }),
      );
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: payload.key,
        }),
      );
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

  async deleteBackup(username: string, key: string, confirmText?: string): Promise<string> {
    if (confirmText !== 'DELETE_BACKUP') {
      throw new BadRequestException('删除二次确认文本错误，必须为 "DELETE_BACKUP"');
    }

    this.validateBackupKey(key);

    const allBackups = await this.listBackups();
    if (allBackups.length === 0) {
      throw new BadRequestException('云端不存在可删除的备份文件');
    }

    const fullBackups = allBackups.filter((b) => (b.scope || 'full') === 'full');
    const newestFullKey = fullBackups[0]?.key;

    if (key === newestFullKey) {
      throw new BadRequestException('最新全站备份点已被永久保护，禁止删除');
    }

    const remainingBackups = allBackups.filter((b) => b.key !== key);
    const remainingFullBackups = remainingBackups.filter((b) => (b.scope || 'full') === 'full');

    if (remainingFullBackups.length < 2) {
      throw new BadRequestException('为确保灾备安全，删除后系统必须保留至少 2 个有效全站恢复点');
    }

    const integrityMap = new Map<string, boolean>();
    let validFullCount = 0;

    for (const b of remainingFullBackups) {
      const isValid = await this.verifyBackupIntegrity(b.key, integrityMap);
      if (isValid) {
        validFullCount++;
      }
    }

    if (validFullCount < 2) {
      throw new BadRequestException(
        `灾备保护拦截：剩余备份中仅有 ${validFullCount} 个经检验合规可用的全站恢复点（需至少 2 个），拒绝删除！`,
      );
    }

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
    } catch (err) {
      console.error('删除对象存储备份失败:', err);
      throw new ServiceUnavailableException('删除云端备份文件失败');
    }

    await this.auditLogService.log(username, 'DELETE_BACKUP', `手动删除云端备份文件: ${key}`);

    return '备份删除成功';
  }

  async cleanRetention(
    username: string,
    dryRun: boolean = true,
    confirmText?: string,
  ): Promise<RetentionResult> {
    const allBackups = await this.listBackups({ includeUploads: true });
    const plan = this.retentionService.calculateRetentionPlan(allBackups);

    if (dryRun) {
      return {
        dryRun: true,
        plannedDeletions: plan.plannedDeletions,
        keptCount: plan.kept.length,
        deletedCount: 0,
      };
    }

    if (process.env.BACKUP_RETENTION_DELETE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('自动保留清理删除模式未在环境变量中启用');
    }

    if (confirmText !== 'EXECUTE_RETENTION_DELETE') {
      throw new BadRequestException('执行保留清理物理删除必须确认文本 "EXECUTE_RETENTION_DELETE"');
    }

    const fullBackups = allBackups.filter(
      (b) => b.key.startsWith('private-backups/database/') && (b.scope || 'full') === 'full',
    );
    const newestFullDbKey = fullBackups[0]?.key;

    const hasDatabaseDeletions = plan.plannedDeletions.some((item) =>
      item.key.startsWith('private-backups/database/'),
    );

    const integrityMap = new Map<string, boolean>();
    let validFullDbCount = 0;

    if (hasDatabaseDeletions) {
      for (const dbMeta of fullBackups) {
        const isValid = await this.verifyBackupIntegrity(dbMeta.key, integrityMap);
        if (isValid) validFullDbCount++;
      }
    }

    let deletedCount = 0;

    for (const item of plan.plannedDeletions) {
      if (item.key === newestFullDbKey) continue;

      if (item.key.startsWith('private-backups/database/')) {
        const isFull = !item.key.includes('/seasons/');
        if (isFull) {
          const isItemValid = integrityMap.get(item.key) ?? false;
          const remainingValidCount = validFullDbCount - (isItemValid ? 1 : 0);

          if (remainingValidCount < 2) {
            console.warn(
              `[Retention] 跳过删除 ${item.key}，原因：删后剩余有效全站恢复点数 (${remainingValidCount}) 不足 2 个`,
            );
            continue;
          }
        }
      }

      try {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: item.key,
          }),
        );
        deletedCount++;

        if (item.key.startsWith('private-backups/database/') && !item.key.includes('/seasons/')) {
          const isItemValid = integrityMap.get(item.key) ?? false;
          if (isItemValid) {
            validFullDbCount--;
          }
        }

        await this.auditLogService.log(
          username,
          'RETENTION_CLEAN_BACKUP',
          `保留策略自动清理备份: ${item.key}，原因: ${item.reason}`,
        );
      } catch (err) {
        console.error(`保留策略删除备份 ${item.key} 失败:`, err);
      }
    }

    const remainingTotal = allBackups.length - deletedCount;

    return {
      dryRun: false,
      plannedDeletions: plan.plannedDeletions,
      keptCount: remainingTotal,
      deletedCount,
    };
  }

  private validateBackupSchemaAndIntegrity(data: any): Record<string, any[]> {
    validateBackupSchemaAndIntegrity(data);
    return data.tables;
  }
}
