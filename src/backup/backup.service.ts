import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MANDATORY_BACKUP_TABLES, validateBackupSchemaAndIntegrity } from './backup-validator';

export { MANDATORY_BACKUP_TABLES, validateBackupSchemaAndIntegrity };

export interface BackupMetadata {
  key: string;
  filename: string;
  size: number;
  lastModified?: Date;
}

export interface BackupManifest {
  formatVersion: string;
  createdAt: string;
  environment: string;
  schemaVersion: string;
  checksumAlgorithm: string;
  checksum: string;
  tables: Record<string, number>;
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
  ) {}

  private validateBackupKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new BadRequestException('备份文件 Key 不能为空');
    }
    if (key.includes('..') || key.includes('\\') || key.startsWith('/')) {
      throw new BadRequestException('非法的备份 Key 路径');
    }
    if (!key.startsWith('private-backups/database/') || !key.endsWith('.json')) {
      throw new BadRequestException(
        '备份 Key 必须位于 private-backups/database/ 目录且为 .json 格式',
      );
    }
  }

  async createBackup(username: string): Promise<BackupMetadata> {
    const {
      tables,
      seasons,
      teams,
      players,
      matches,
      seasonTeamPlayers,
      matchLineups,
      goals,
      matchEvents,
      news,
      auditLogs,
    } = await this.prisma.$transaction(
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

        const tablesData: Record<string, any[]> = {
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

        return {
          tables: tablesData,
          seasons: seasonsList,
          teams: teamsList,
          players: playersList,
          matches: matchesList,
          seasonTeamPlayers: seasonTeamPlayersList,
          matchLineups: matchLineupsList,
          goals: goalsList,
          matchEvents: matchEventsList,
          news: newsList,
          auditLogs: auditLogsList,
        };
      },
      {
        isolationLevel: 'RepeatableRead',
        timeout: 60000,
      },
    );

    const tableCounts: Record<string, number> = {};
    for (const [tableName, list] of Object.entries(tables)) {
      tableCounts[tableName] = list.length;
    }

    const tablesJson = JSON.stringify(tables);
    const checksum = crypto.createHash('sha256').update(tablesJson).digest('hex');

    const manifest: BackupManifest = {
      formatVersion: '2.0',
      createdAt: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      schemaVersion: '2.0',
      checksumAlgorithm: 'sha256',
      checksum,
      tables: tableCounts,
    };

    const backupData = {
      manifest,
      tables,
      formatVersion: '2.0',
      timestamp: Date.now(),
      seasons,
      teams,
      players,
      matches,
      seasonTeamPlayers,
      matchLineups,
      goals,
      matchEvents,
      news,
      auditLogs,
    };

    const serializedData = JSON.stringify(backupData, null, 2);
    const buffer = Buffer.from(serializedData, 'utf-8');
    const fileKey = `private-backups/database/backup_${Date.now()}.json`;

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: fileKey,
          Body: buffer,
          ContentType: 'application/json',
        }),
      );
    } catch (err) {
      console.error('上传备份文件至 R2 失败:', err);
      throw new ServiceUnavailableException('无法将备份文件保存至对象存储');
    }

    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `触发全表数据库备份，备份文件: ${fileKey}，覆盖全部 17 个数据模型。`,
    );

    return {
      key: fileKey,
      filename: fileKey.replace('private-backups/database/', ''),
      size: buffer.length,
      lastModified: new Date(),
    };
  }

  async listBackups(): Promise<BackupMetadata[]> {
    try {
      const privateRes = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME,
          Prefix: 'private-backups/database/',
        }),
      );

      const files = privateRes.Contents || [];

      return files
        .filter((file) => file.Key && file.Key.endsWith('.json'))
        .map((file) => {
          const key = file.Key || '';
          const filename = key.replace('private-backups/database/', '');
          return {
            key,
            filename,
            size: file.Size || 0,
            lastModified: file.LastModified,
          };
        })
        .sort((a, b) => {
          const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          return timeB - timeA;
        });
    } catch (err) {
      console.error('获取 R2 备份列表失败:', err);
      return [];
    }
  }

  async getPresignedDownloadUrl(key: string): Promise<string> {
    this.validateBackupKey(key);

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    return await getSignedUrl(this.s3Client, command, { expiresIn: 300 });
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

    // 1. 尝试从 R2 读取备份文件（限制最大 50MB 内存）
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

    const streamToString = (stream: any): Promise<string> =>
      new Promise((resolve, reject) => {
        const chunks: any[] = [];
        let totalSize = 0;
        const maxBytes = 50 * 1024 * 1024;
        stream.on('data', (chunk: any) => {
          totalSize += chunk.length;
          if (totalSize > maxBytes) {
            reject(new BadRequestException('备份文件体积超过 50MB 允许限制'));
          } else {
            chunks.push(chunk);
          }
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });

    let jsonStr: string;
    try {
      jsonStr = await streamToString(s3Response.Body);
    } catch {
      throw new UnprocessableEntityException('读取备份文件流失败');
    }

    let rawData: any;
    try {
      rawData = JSON.parse(jsonStr);
    } catch {
      throw new BadRequestException('备份文件内容为无效 JSON 结构');
    }

    // 2. 在开启破坏性事务前，执行全量 Schema、计数、摘要及外键依赖强校验
    const tablesData = this.validateBackupSchemaAndIntegrity(rawData);

    // 3. 自动生成恢复前快照，快照保存至 R2 成功后才允许进入事务
    let preRestoreSnapshotKey = '';
    try {
      const snapshotMeta = await this.createBackup(`pre-restore-auto-${username}`);
      preRestoreSnapshotKey = snapshotMeta.key;
    } catch (snapshotErr) {
      throw new ServiceUnavailableException(
        `恢复前自动创建快照失败，为防止数据不可逆丢失，已终止恢复操作: ${
          snapshotErr instanceof Error ? snapshotErr.message : '未知错误'
        }`,
      );
    }

    // 4. 事务保护：通过 pg_try_advisory_xact_lock 实现数据库级别的事务互斥锁
    try {
      await this.prisma.$transaction(
        async (tx) => {
          // A. 竞争事务级 Advisory Lock (锁 ID: 88998899)
          const [{ locked }] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
          if (!locked) {
            throw new ConflictException('已有其他进程或节点正在执行数据库恢复操作，请求被拒绝');
          }

          // B. 解开循环/可空外键约束
          await tx.match.updateMany({ data: { mvpPlayerId: null } });
          await tx.player.updateMany({ data: { suspendedAtMatchId: null } });
          await tx.user.updateMany({ data: { teamId: null } });

          // C. 逆序擦除全量 17 张表
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

          // D. 按拓扑依赖层级写入 17 张表
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

          // 重新关联循环外键
          for (const m of tablesData.Match || []) {
            if (m.mvpPlayerId) {
              await tx.match.update({
                where: { id: m.id },
                data: { mvpPlayerId: m.mvpPlayerId },
              });
            }
          }
          for (const p of tablesData.Player || []) {
            if (p.suspendedAtMatchId) {
              await tx.player.update({
                where: { id: p.id },
                data: { suspendedAtMatchId: p.suspendedAtMatchId },
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

          // 还原用户球队绑定
          for (const u of tablesData.User || []) {
            if (u.teamId) {
              await tx.user.update({
                where: { id: u.id },
                data: { teamId: u.teamId },
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

  private validateBackupSchemaAndIntegrity(data: any): Record<string, any[]> {
    validateBackupSchemaAndIntegrity(data);
    return data.tables;
  }
}
