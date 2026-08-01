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
import { MANDATORY_BACKUP_TABLES, validateBackupSchemaAndIntegrity } from './backup-validator';
import { prepareV3BackupStream, parseAndValidateBackupStream } from './backup-serializer';
import { BackupRetentionService, RetentionResult } from './backup-retention.service';

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
}

export interface UploadInitResult {
  uploadToken: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
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
    return crypto.createHmac('sha256', jwtSecret).update('antigravity-backup-upload-token').digest();
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

  async createBackup(
    username: string,
    options?: { purpose?: 'manual' | 'scheduled' | 'pre-restore' | 'uploaded'; protected?: boolean },
  ): Promise<BackupMetadata> {
    const purpose = options?.purpose || 'manual';
    const isProtected = !!options?.protected;

    const tables = await this.prisma.$transaction(
      async (tx) => {
        const users = await tx.user.findMany();
        const teamsList = await tx.team.findMany();
        const playersList = await tx.player.findMany();
        const matchesList = await tx.match.findMany();
        const predictions = await tx.prediction.findMany();
        const goalsList = await tx.goal.findMany();
        const matchEventsList = await tx.matchEvent.findMany();
        const newsList = await tx.news.findMany();
        const auditLogsList = await tx.auditLog.findMany();
        const seasonsList = await tx.season.findMany();
        const seasonTeamProfiles = await tx.seasonTeamProfile.findMany();
        const historyImportBatches = await tx.historyImportBatch.findMany();
        const seasonDeletionApprovals = await tx.seasonDeletionApproval.findMany();
        const seasonTeamPlayersList = await tx.seasonTeamPlayer.findMany();
        const matchLineupsList = await tx.matchLineup.findMany();
        const seasonGroupTeams = await tx.seasonGroupTeam.findMany();
        const pdfImportBatches = await tx.pdfImportBatch.findMany();

        return {
          User: users,
          Team: teamsList,
          Player: playersList,
          Match: matchesList,
          Prediction: predictions,
          Goal: goalsList,
          MatchEvent: matchEventsList,
          News: newsList,
          AuditLog: auditLogsList,
          Season: seasonsList,
          SeasonTeamProfile: seasonTeamProfiles,
          HistoryImportBatch: historyImportBatches,
          SeasonDeletionApproval: seasonDeletionApprovals,
          SeasonTeamPlayer: seasonTeamPlayersList,
          MatchLineup: matchLineupsList,
          SeasonGroupTeam: seasonGroupTeams,
          PdfImportBatch: pdfImportBatches,
        };
      },
      {
        isolationLevel: 'RepeatableRead',
        timeout: 60000,
      },
    );

    const createdAtIso = new Date().toISOString();
    const { stream, checksum } = prepareV3BackupStream(tables, { createdAt: createdAtIso });

    const protectSuffix = isProtected ? '_protected' : '';
    const filename = `backup_${Date.now()}_${purpose}${protectSuffix}.json.gz`;
    const fileKey = `private-backups/database/${filename}`;

    try {
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
      await parallelUpload.done();
    } catch (err) {
      console.error('上传备份文件至 R2 失败:', err);
      throw new ServiceUnavailableException('无法将备份文件保存至对象存储');
    }

    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `触发全表数据库备份 (V3.0 GZIP)，备份文件: ${fileKey}，包含全部 17 个数据模型。`,
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
          throw new ServiceUnavailableException(
            `拉取 ${prefix} 超出最大允许页数限制`,
          );
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
              `R2 列表分页令牌失效或遭遇循环引用 (${prefix})，为防止不完整列表导致安全操作失误，拒绝继续执行`,
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

  async verifyBackupIntegrity(key: string): Promise<boolean> {
    try {
      const s3Response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );
      const { rawData } = await parseAndValidateBackupStream(s3Response.Body as any, key);
      this.validateBackupSchemaAndIntegrity(rawData);
      return true;
    } catch {
      return false;
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

    const { rawData } = await parseAndValidateBackupStream(s3Response.Body as any, key);
    const tablesData = this.validateBackupSchemaAndIntegrity(rawData);

    let preRestoreSnapshotKey = '';
    try {
      const snapshotMeta = await this.createBackup(username, { purpose: 'pre-restore' });
      preRestoreSnapshotKey = snapshotMeta.key;
    } catch (snapshotErr) {
      throw new ServiceUnavailableException(
        `恢复前自动创建快照失败，为防止数据不可逆丢失，已终止恢复操作: ${
          snapshotErr instanceof Error ? snapshotErr.message : '未知错误'
        }`,
      );
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
          if (!locked) {
            throw new ConflictException('已有其他进程或节点正在执行数据库恢复操作，请求被拒绝');
          }

          await tx.match.updateMany({ data: { mvpPlayerId: null } });
          await tx.player.updateMany({ data: { suspendedAtMatchId: null } });
          await tx.user.updateMany({ data: { teamId: null } });

          await tx.matchLineup.deleteMany();
          await tx.seasonTeamPlayer.deleteMany();
          await tx.seasonTeamProfile.deleteMany();
          await tx.seasonGroupTeam.deleteMany();
          await tx.seasonDeletionApproval.deleteMany();
          await tx.goal.deleteMany();
          await tx.matchEvent.deleteMany();
          await tx.prediction.deleteMany();
          await tx.player.deleteMany();
          await tx.match.deleteMany();
          await tx.team.deleteMany();
          await tx.user.deleteMany();
          await tx.season.deleteMany();
          await tx.news.deleteMany();
          await tx.auditLog.deleteMany();
          await tx.historyImportBatch.deleteMany();
          await tx.pdfImportBatch.deleteMany();

          if (tablesData.User?.length) {
            await tx.user.createMany({
              data: tablesData.User.map((u: any) => ({
                ...u,
                teamId: null,
                createdAt: u.createdAt ? new Date(u.createdAt) : undefined,
                updatedAt: u.updatedAt ? new Date(u.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.Season?.length) {
            await tx.season.createMany({
              data: tablesData.Season.map((s: any) => ({
                ...s,
                createdAt: s.createdAt ? new Date(s.createdAt) : undefined,
                updatedAt: s.updatedAt ? new Date(s.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.Team?.length) {
            await tx.team.createMany({
              data: tablesData.Team.map((t: any) => ({
                ...t,
                deletedAt: t.deletedAt ? new Date(t.deletedAt) : null,
                createdAt: t.createdAt ? new Date(t.createdAt) : undefined,
                updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.Player?.length) {
            await tx.player.createMany({
              data: tablesData.Player.map((p: any) => ({
                ...p,
                suspendedAtMatchId: null,
                deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
                createdAt: p.createdAt ? new Date(p.createdAt) : undefined,
                updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.Match?.length) {
            await tx.match.createMany({
              data: tablesData.Match.map((m: any) => ({
                ...m,
                mvpPlayerId: null,
                matchDate: new Date(m.matchDate),
                deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
                createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
                updatedAt: m.updatedAt ? new Date(m.updatedAt) : undefined,
              })),
            });
          }

          for (const m of tablesData.Match || []) {
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
          for (const p of tablesData.Player || []) {
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

          if (tablesData.SeasonTeamProfile?.length) {
            await tx.seasonTeamProfile.createMany({
              data: tablesData.SeasonTeamProfile.map((stp: any) => ({
                ...stp,
                createdAt: stp.createdAt ? new Date(stp.createdAt) : undefined,
                updatedAt: stp.updatedAt ? new Date(stp.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.SeasonGroupTeam?.length) {
            await tx.seasonGroupTeam.createMany({
              data: tablesData.SeasonGroupTeam.map((sgt: any) => ({
                ...sgt,
                createdAt: sgt.createdAt ? new Date(sgt.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.SeasonTeamPlayer?.length) {
            await tx.seasonTeamPlayer.createMany({
              data: tablesData.SeasonTeamPlayer.map((stp: any) => ({
                ...stp,
                createdAt: stp.createdAt ? new Date(stp.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.SeasonDeletionApproval?.length) {
            await tx.seasonDeletionApproval.createMany({
              data: tablesData.SeasonDeletionApproval.map((sda: any) => ({
                ...sda,
                createdAt: sda.createdAt ? new Date(sda.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.MatchLineup?.length) {
            await tx.matchLineup.createMany({
              data: tablesData.MatchLineup,
            });
          }
          if (tablesData.Goal?.length) {
            await tx.goal.createMany({
              data: tablesData.Goal.map((g: any) => ({
                ...g,
                createdAt: g.createdAt ? new Date(g.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.MatchEvent?.length) {
            await tx.matchEvent.createMany({
              data: tablesData.MatchEvent.map((e: any) => ({
                ...e,
                createdAt: e.createdAt ? new Date(e.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.Prediction?.length) {
            await tx.prediction.createMany({
              data: tablesData.Prediction.map((pr: any) => ({
                ...pr,
                submittedAt: pr.submittedAt ? new Date(pr.submittedAt) : undefined,
                settledAt: pr.settledAt ? new Date(pr.settledAt) : null,
                createdAt: pr.createdAt ? new Date(pr.createdAt) : undefined,
                updatedAt: pr.updatedAt ? new Date(pr.updatedAt) : undefined,
              })),
            });
          }

          for (const u of tablesData.User || []) {
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

          if (tablesData.News?.length) {
            await tx.news.createMany({
              data: tablesData.News.map((n: any) => ({
                ...n,
                publishedAt: n.publishedAt ? new Date(n.publishedAt) : undefined,
                deletedAt: n.deletedAt ? new Date(n.deletedAt) : null,
                createdAt: n.createdAt ? new Date(n.createdAt) : undefined,
                updatedAt: n.updatedAt ? new Date(n.updatedAt) : undefined,
              })),
            });
          }
          if (tablesData.AuditLog?.length) {
            await tx.auditLog.createMany({
              data: tablesData.AuditLog.map((al: any) => ({
                ...al,
                createdAt: al.createdAt ? new Date(al.createdAt) : undefined,
              })),
            });
          }
          if (tablesData.HistoryImportBatch?.length) {
            await tx.historyImportBatch.createMany({
              data: tablesData.HistoryImportBatch.map((hib: any) => ({
                ...hib,
                createdAt: hib.createdAt ? new Date(hib.createdAt) : undefined,
                undoneAt: hib.undoneAt ? new Date(hib.undoneAt) : null,
              })),
            });
          }
          if (tablesData.PdfImportBatch?.length) {
            await tx.pdfImportBatch.createMany({
              data: tablesData.PdfImportBatch.map((pib: any) => ({
                ...pib,
                expiresAt: new Date(pib.expiresAt),
                commitStartedAt: pib.commitStartedAt ? new Date(pib.commitStartedAt) : null,
                committedAt: pib.committedAt ? new Date(pib.committedAt) : null,
                failedAt: pib.failedAt ? new Date(pib.failedAt) : null,
                createdAt: pib.createdAt ? new Date(pib.createdAt) : undefined,
                updatedAt: pib.updatedAt ? new Date(pib.updatedAt) : undefined,
              })),
            });
          }
        },
        {
          maxWait: 10000,
          timeout: 60000,
        },
      );

      await this.auditLogService.log(
        username,
        'RESTORE_BACKUP',
        `从备份 ${key} 成功全量覆盖还原数据库，前置自动快照: ${preRestoreSnapshotKey}。`,
      );

      return '数据库还原成功';
    } catch (err) {
      console.error('还原备份失败:', err);
      if (
        err instanceof BadRequestException ||
        err instanceof ServiceUnavailableException ||
        err instanceof ConflictException
      ) {
        throw err;
      }
      throw new Error(`还原备份失败: ${err instanceof Error ? err.message : '未知错误'}`);
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
    const expectedSigHex = crypto.createHmac('sha256', hmacSecret).update(payloadBase64).digest('hex');

    const sigBuf = Buffer.from(sigHex, 'utf8');
    const expectedBuf = Buffer.from(expectedSigHex, 'utf8');

    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
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

    let parseResult;
    try {
      parseResult = await parseAndValidateBackupStream(getRes.Body as any, payload.key);

      if (parseResult.fileSha256.toLowerCase() !== payload.fileSha256.toLowerCase()) {
        throw new BadRequestException('上传文件哈希与初始化摘要不一致，数据可能已被篡改');
      }

      this.validateBackupSchemaAndIntegrity(parseResult.rawData);
    } catch (validationErr) {
      await this.s3Client
        .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: payload.key }))
        .catch(() => {});
      throw validationErr;
    }

    const isGzip = payload.key.endsWith('.json.gz');
    const ext = isGzip ? '.json.gz' : '.json';
    const targetFilename = `backup_${Date.now()}_uploaded${ext}`;
    const targetKey = `private-backups/database/${targetFilename}`;

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

    const newestKey = allBackups[0]?.key;
    if (key === newestKey) {
      throw new BadRequestException('最新备份点已被永久保护，禁止删除');
    }

    const remainingBackups = allBackups.filter((b) => b.key !== key);
    if (remainingBackups.length < 2) {
      throw new BadRequestException('为确保灾备安全，删除后系统必须保留至少 2 个有效恢复点');
    }

    let validCount = 0;
    for (const b of remainingBackups) {
      const isValid = await this.verifyBackupIntegrity(b.key);
      if (isValid) {
        validCount++;
      }
    }

    if (validCount < 2) {
      throw new BadRequestException(
        `灾备保护拦截：剩余备份中仅有 ${validCount} 个经检验合规可用的恢复点（需至少 2 个），拒绝删除！`,
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

    await this.auditLogService.log(
      username,
      'DELETE_BACKUP',
      `手动删除云端备份文件: ${key}`,
    );

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
      throw new BadRequestException(
        '执行保留清理物理删除必须确认文本 "EXECUTE_RETENTION_DELETE"',
      );
    }

    const newestDbKey = allBackups.find((b) => b.key.startsWith('private-backups/database/'))?.key;
    const hasDatabaseDeletions = plan.plannedDeletions.some((item) =>
      item.key.startsWith('private-backups/database/'),
    );

    const integrityMap = new Map<string, boolean>();
    let validDbCount = 0;

    // 仅在清理计划中包含正式数据库备份时才启动一次性完整性校验，避免纯 uploads/ 清理产生 R2 校验流量
    if (hasDatabaseDeletions) {
      const dbBackups = allBackups.filter((b) => b.key.startsWith('private-backups/database/'));
      for (const dbMeta of dbBackups) {
        const isValid = await this.verifyBackupIntegrity(dbMeta.key);
        integrityMap.set(dbMeta.key, isValid);
        if (isValid) validDbCount++;
      }
    }

    let deletedCount = 0;

    for (const item of plan.plannedDeletions) {
      if (item.key === newestDbKey) continue;

      if (item.key.startsWith('private-backups/database/')) {
        const isItemValid = integrityMap.get(item.key) ?? false;
        const remainingValidCount = validDbCount - (isItemValid ? 1 : 0);

        if (remainingValidCount < 2) {
          console.warn(
            `[Retention] 跳过删除 ${item.key}，原因：删后剩余有效恢复点数 (${remainingValidCount}) 不足 2 个`,
          );
          continue;
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

        if (item.key.startsWith('private-backups/database/')) {
          const isItemValid = integrityMap.get(item.key) ?? false;
          if (isItemValid) {
            validDbCount--;
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
