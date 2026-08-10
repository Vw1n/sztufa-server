import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  TABLE_METADATA_MAP,
  RESTORE_DELETE_ORDER,
  RESTORE_INSERT_ORDER,
} from './backup-table-registry';
import { ParseStreamResult } from './backup-serializer';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupExportService } from './backup-export.service';

/**
 * 备份恢复服务。
 * 负责：功能开关与确认文本校验、下载并验证备份、校验恢复范围、
 * 创建恢复前快照、获取 advisory lock、在事务中按既定顺序删除并重建数据、
 * 失败时清理 staging 资源并记录审计日志。
 * 单向依赖 BackupExportService 以创建恢复前快照。
 */
@Injectable()
export class BackupRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly exportService: BackupExportService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async restoreBackup(username: string, key: string, confirmText?: string): Promise<string> {
    if (process.env.BACKUP_RESTORE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('备份恢复功能未启用');
    }

    if (confirmText !== 'CONFIRM_RESTORE') {
      throw new BadRequestException(
        '覆盖恢复请求缺少二次确认标识或确认文本错误 (需提交 "CONFIRM_RESTORE")',
      );
    }

    this.objectStore.validateBackupKey(key);

    const body = await this.objectStore.getObjectBody(key);

    let parseResult: ParseStreamResult | null = null;
    try {
      parseResult = await this.verificationService.parseAndValidate(body);
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
      const snapshotMeta = await this.exportService.createBackup(username, {
        purpose: 'pre-restore',
      });
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
      throw new InternalServerErrorException(
        `数据库覆盖还原事务失败：${err?.message || '未知数据库错误'}`,
      );
    } finally {
      if (parseResult) parseResult.cleanup();
    }
  }
}
