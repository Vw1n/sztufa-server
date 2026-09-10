import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupRetentionService } from './backup-retention.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackupMetadata, CreateBackupOptions } from './backup.types';
import { BackupModuleRestoreService } from './backup-module-restore.service';
import { BackupModule } from './backup-module-registry';

// 保持既有外部导入兼容性的符号 re-export
export { MANDATORY_BACKUP_TABLES } from './backup-table-registry';
export { validateBackupSchemaAndIntegrity } from './backup-validator';
export type { BackupMetadata, UploadInitResult, CreateBackupOptions } from './backup.types';

export const LEASE_TTL_MS = 300_000; // 5 分钟
export const BATCH_TIME_BUDGET_MS = 240_000; // 240 秒
export const REQUIRED_MODULES = ['season', 'staff', 'members', 'content', 'operations'] as const;

export type ScheduledModuleTaskResult =
  | {
      status: 'created';
      module: BackupModule;
      selector?: Record<string, string>;
      backup: BackupMetadata;
      durationMs: number;
      finishedAt: string;
    }
  | {
      status: 'skipped';
      module: BackupModule;
      selector?: Record<string, string>;
      reason: 'no_eligible_season' | 'minimum_interval' | 'unchanged';
      existingBackup?: BackupMetadata;
      finishedAt: string;
    }
  | {
      status: 'failed';
      module: BackupModule;
      selector?: Record<string, string>;
      reason?: 'time_budget_exhausted' | 'export_error';
      error: string;
      finishedAt: string;
    };

export interface BackupBatchResult {
  batchId: string;
  periodKey: string;
  targetSeasonId: string | null;
  status: 'running' | 'succeeded' | 'incomplete' | 'failed';
  succeeded: number;
  skipped: number;
  failed: number;
  items: ScheduledModuleTaskResult[];
}

export function getShanghaiPeriodKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).format(date);
}

/**
 * 备份模块兼容门面。
 * 仅负责将公开方法显式委托给对应的领域子服务，
 * 不再包含任何业务实现，便于各链路独立测试与审查。
 */
@Injectable()
export class BackupService {
  constructor(
    private readonly exportService: BackupExportService,
    private readonly restoreService: BackupRestoreService,
    private readonly uploadService: BackupUploadService,
    private readonly maintenanceService: BackupMaintenanceService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly scopeService: BackupScopeService,
    private readonly retentionService: BackupRetentionService,
    private readonly prisma: PrismaService,
    private readonly moduleRestoreService: BackupModuleRestoreService,
  ) {}

  private async getLatestBusinessChange(options: CreateBackupOptions): Promise<Date | null> {
    const scope = options.scope || 'full';
    const module = scope === 'module' ? options.module : 'full';
    const seasonId = options.selector?.seasonId || options.seasonId;
    let queries: Promise<any>[];

    if (module === 'season' && seasonId) {
      queries = [
        this.prisma.season.aggregate({ where: { id: seasonId }, _max: { updatedAt: true } }),
        this.prisma.match.aggregate({ where: { seasonId }, _max: { updatedAt: true } }),
        this.prisma.goal.aggregate({ where: { match: { seasonId } }, _max: { createdAt: true } }),
        this.prisma.matchEvent.aggregate({
          where: { match: { seasonId } },
          _max: { createdAt: true },
        }),
        this.prisma.seasonTeamProfile.aggregate({ where: { seasonId }, _max: { updatedAt: true } }),
        this.prisma.seasonTeamPlayer.aggregate({ where: { seasonId }, _max: { createdAt: true } }),
        this.prisma.teamRegistration.aggregate({ where: { seasonId }, _max: { updatedAt: true } }),
      ];
    } else if (module === 'staff') {
      queries = [
        this.prisma.user.aggregate({ _max: { updatedAt: true } }),
        this.prisma.adminFormDraft.aggregate({ _max: { updatedAt: true } }),
      ];
    } else if (module === 'members') {
      queries = [this.prisma.memberAccount.aggregate({ _max: { updatedAt: true } })];
    } else if (module === 'content') {
      queries = [this.prisma.news.aggregate({ _max: { updatedAt: true } })];
    } else if (module === 'operations') {
      queries = [
        this.prisma.auditLog.aggregate({ _max: { createdAt: true } }),
        this.prisma.historyImportBatch.aggregate({ _max: { createdAt: true } }),
        this.prisma.pdfImportBatch.aggregate({ _max: { updatedAt: true } }),
      ];
    } else {
      queries = [
        this.prisma.team.aggregate({ _max: { updatedAt: true } }),
        this.prisma.player.aggregate({ _max: { updatedAt: true } }),
        this.prisma.match.aggregate({ _max: { updatedAt: true } }),
        this.prisma.news.aggregate({ _max: { updatedAt: true } }),
        this.prisma.season.aggregate({ _max: { updatedAt: true } }),
        this.prisma.prediction.aggregate({ _max: { updatedAt: true } }),
        this.prisma.seasonTeamProfile.aggregate({ _max: { updatedAt: true } }),
        this.prisma.adminFormDraft.aggregate({ _max: { updatedAt: true } }),
        this.prisma.goal.aggregate({ _max: { createdAt: true } }),
        this.prisma.matchEvent.aggregate({ _max: { createdAt: true } }),
        this.prisma.seasonTeamPlayer.aggregate({ _max: { createdAt: true } }),
      ];
    }
    const results = await Promise.all(queries);
    const timestamps = results.flatMap((result) => Object.values(result._max)).filter(Boolean);
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps.map((value) => new Date(value as Date).getTime())));
  }

  createBackup(username: string, options?: Parameters<BackupExportService['createBackup']>[1]) {
    return this.exportService.createBackup(username, options);
  }

  async createScheduledBackup(
    username: string,
    options?: CreateBackupOptions,
  ): Promise<ScheduledModuleTaskResult> {
    if (options?.scope === 'full') {
      throw new BadRequestException('定时备份禁止全量备份 (scope=full)');
    }

    const scheduledOptions: CreateBackupOptions =
      options?.scope === 'module' && options.module
        ? options
        : await this.resolveScheduledBackupOptions(options?.signal);

    const targetModule = scheduledOptions.module!;
    const selector = scheduledOptions.selector || {};
    const seasonId = selector.seasonId || scheduledOptions.seasonId;

    if (targetModule === 'season' && !seasonId) {
      return {
        status: 'skipped',
        module: 'season',
        selector,
        reason: 'no_eligible_season',
        finishedAt: new Date().toISOString(),
      };
    }

    const configuredHours = Number(process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS || 144);
    const minIntervalHours = Number.isFinite(configuredHours) ? Math.max(0, configuredHours) : 144;

    if (minIntervalHours > 0) {
      const backups = await this.objectStore.listBackups();
      const cutoff = Date.now() - minIntervalHours * 60 * 60 * 1000;
      const latestScheduled = backups.find(
        (backup) =>
          backup.purpose === 'scheduled' &&
          backup.scope === 'module' &&
          backup.module === targetModule &&
          (backup.seasonId || undefined) === (seasonId || undefined) &&
          !!backup.lastModified,
      );

      if (latestScheduled?.lastModified) {
        const latestBackupTime = new Date(latestScheduled.lastModified).getTime();
        if (latestBackupTime >= cutoff) {
          return {
            status: 'skipped',
            module: targetModule,
            selector,
            reason: 'minimum_interval',
            existingBackup: latestScheduled,
            finishedAt: new Date().toISOString(),
          };
        }

        if (process.env.SCHEDULED_BACKUP_CHANGE_DETECTION_ENABLED !== 'false') {
          const latestChange = await this.getLatestBusinessChange(scheduledOptions);
          if (!latestChange || latestChange.getTime() <= latestBackupTime) {
            return {
              status: 'skipped',
              module: targetModule,
              selector,
              reason: 'unchanged',
              existingBackup: latestScheduled,
              finishedAt: new Date().toISOString(),
            };
          }
        }
      }
    }

    const start = Date.now();
    try {
      const backup = await this.exportService.createBackup(username, {
        ...scheduledOptions,
        purpose: 'scheduled',
      });
      return {
        status: 'created',
        module: targetModule,
        selector,
        backup,
        durationMs: Date.now() - start,
        finishedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const isAborted =
        scheduledOptions.signal?.aborted ||
        err.name === 'AbortError' ||
        err.message?.includes('aborted');
      if (isAborted) {
        return {
          status: 'failed',
          module: targetModule,
          selector,
          reason: 'time_budget_exhausted',
          error: '批次执行预算耗尽 (240s)，已安全中止',
          finishedAt: new Date().toISOString(),
        };
      }
      return {
        status: 'failed',
        module: targetModule,
        selector,
        reason: 'export_error',
        error: err.message || '导出异常',
        finishedAt: new Date().toISOString(),
      };
    }
  }

  async acquireBatchLease(
    periodKey: string,
    trigger: 'cron' | 'manual' | 'retry',
    targetSeasonId?: string | null,
  ): Promise<
    | { acquired: true; batch: any; leaseToken: string }
    | {
        acquired: false;
        reason: 'already_succeeded' | 'running_active_lease' | 'cas_conflict';
        batch?: any;
      }
  > {
    const newLeaseToken = randomUUID();
    const newLeaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);

    // 步骤 1: 尝试原子新建批次
    try {
      const created = await this.prisma.backupBatch.create({
        data: {
          periodKey,
          trigger,
          status: 'running',
          leaseToken: newLeaseToken,
          leaseExpiresAt: newLeaseExpiresAt,
          targetSeasonId: targetSeasonId ?? null,
          items: [],
        },
      });
      return { acquired: true, batch: created, leaseToken: newLeaseToken };
    } catch (err: any) {
      if (err.code !== 'P2002' && !err.message?.includes('Unique constraint')) {
        throw err;
      }
    }

    // 步骤 2: 批次已存在，检查状态
    const existing = await this.prisma.backupBatch.findUnique({
      where: { periodKey },
    });
    if (!existing) {
      return { acquired: false, reason: 'cas_conflict' };
    }

    if (existing.status === 'succeeded') {
      return { acquired: false, reason: 'already_succeeded', batch: existing };
    }

    const now = new Date();
    if (existing.status === 'running' && existing.leaseExpiresAt && existing.leaseExpiresAt > now) {
      return { acquired: false, reason: 'running_active_lease', batch: existing };
    }

    // 步骤 3: stale running, incomplete 或 failed 批次，CAS 原子抢占
    const updateResult = await this.prisma.backupBatch.updateMany({
      where: {
        periodKey,
        OR: [
          { status: 'running', leaseExpiresAt: { lte: now } },
          { status: 'incomplete' },
          { status: 'failed' },
        ],
      },
      data: {
        status: 'running',
        leaseToken: newLeaseToken,
        leaseExpiresAt: newLeaseExpiresAt,
      },
    });

    if (updateResult.count === 1) {
      const updated = await this.prisma.backupBatch.findUnique({ where: { periodKey } });
      return { acquired: true, batch: updated!, leaseToken: newLeaseToken };
    }

    return { acquired: false, reason: 'cas_conflict' };
  }

  private async executeBatchRun(
    batch: any,
    leaseToken: string,
    username: string,
  ): Promise<BackupBatchResult> {
    const batchAbortController = new AbortController();
    const batchTimer = setTimeout(() => batchAbortController.abort(), BATCH_TIME_BUDGET_MS);
    const currentItems: ScheduledModuleTaskResult[] = Array.isArray(batch.items)
      ? (batch.items as any)
      : [];

    const targetSeasonId = batch.targetSeasonId;

    try {
      for (const mod of REQUIRED_MODULES) {
        // 检查该模块是否已满足（已完成或安全跳过）
        const existingItem = currentItems.find((it) => it.module === mod);
        if (
          existingItem &&
          (existingItem.status === 'created' || existingItem.status === 'skipped')
        ) {
          continue;
        }

        let taskResult: ScheduledModuleTaskResult;

        if (batchAbortController.signal.aborted) {
          taskResult = {
            status: 'failed',
            module: mod,
            reason: 'time_budget_exhausted',
            error: '批次执行预算耗尽 (240s)，已安全中止',
            finishedAt: new Date().toISOString(),
          };
        } else if (mod === 'season') {
          if (!targetSeasonId) {
            taskResult = {
              status: 'skipped',
              module: 'season',
              selector: {},
              reason: 'no_eligible_season',
              finishedAt: new Date().toISOString(),
            };
          } else {
            taskResult = await this.createScheduledBackup(username, {
              scope: 'module',
              module: 'season',
              selector: { seasonId: targetSeasonId },
              signal: batchAbortController.signal,
            });
          }
        } else {
          taskResult = await this.createScheduledBackup(username, {
            scope: 'module',
            module: mod,
            selector: {},
            signal: batchAbortController.signal,
          });
        }

        // 覆盖/替换原模块结果
        const existingIdx = currentItems.findIndex((it) => it.module === mod);
        if (existingIdx >= 0) {
          currentItems[existingIdx] = taskResult;
        } else {
          currentItems.push(taskResult);
        }

        // 模块级流水线落库与严格续租校验
        const persistResult = await this.prisma.backupBatch.updateMany({
          where: {
            id: batch.id,
            leaseToken,
            status: 'running',
            leaseExpiresAt: { gt: new Date() },
          },
          data: {
            items: currentItems as any,
            leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
          },
        });

        if (persistResult.count === 0) {
          throw new Error('批次执行租约已过期或被其他实例接管，安全中止后续模块');
        }
      }

      // 判定完成度
      const isAllSatisfied = REQUIRED_MODULES.every((mod) => {
        const item = currentItems.find((it) => it.module === mod);
        return item && (item.status === 'created' || item.status === 'skipped');
      });

      const finalStatus: 'succeeded' | 'incomplete' = isAllSatisfied ? 'succeeded' : 'incomplete';

      const finalUpdateResult = await this.prisma.backupBatch.updateMany({
        where: {
          id: batch.id,
          leaseToken,
          status: 'running',
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: finalStatus,
          items: currentItems as any,
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        },
      });

      if (finalUpdateResult.count === 0) {
        throw new Error('批次终态写入失败：租约已失效或被其他实例抢占');
      }

      return {
        batchId: batch.id,
        periodKey: batch.periodKey,
        targetSeasonId,
        status: finalStatus,
        succeeded: currentItems.filter((it) => it.status === 'created').length,
        skipped: currentItems.filter((it) => it.status === 'skipped').length,
        failed: currentItems.filter((it) => it.status === 'failed').length,
        items: currentItems,
      };
    } finally {
      clearTimeout(batchTimer);
    }
  }

  async createScheduledBackupBatch(username: string): Promise<BackupBatchResult> {
    const periodKey = getShanghaiPeriodKey();
    const activeSeason = await this.prisma.season.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const leaseRes = await this.acquireBatchLease(periodKey, 'cron', activeSeason?.id);
    if (!leaseRes.acquired) {
      const b = leaseRes.batch;
      const items: ScheduledModuleTaskResult[] = Array.isArray(b?.items) ? (b.items as any) : [];
      return {
        batchId: b?.id || `batch_${periodKey}`,
        periodKey,
        targetSeasonId: b?.targetSeasonId || null,
        status: b?.status || 'running',
        succeeded: items.filter((it) => it.status === 'created').length,
        skipped: items.filter((it) => it.status === 'skipped').length,
        failed: items.filter((it) => it.status === 'failed').length,
        items,
      };
    }

    return this.executeBatchRun(leaseRes.batch, leaseRes.leaseToken, username);
  }

  async retryScheduledBackupBatch(batchId: string, username: string): Promise<BackupBatchResult> {
    const batch = await this.prisma.backupBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      throw new NotFoundException(`未找到 ID 为 ${batchId} 的备份批次`);
    }
    if (batch.status === 'succeeded') {
      throw new BadRequestException('批次所有模块已满足，无需重试');
    }
    const now = new Date();
    if (batch.status === 'running' && batch.leaseExpiresAt && batch.leaseExpiresAt > now) {
      throw new ConflictException('批次正在执行中，请勿重复触发');
    }

    const newLeaseToken = randomUUID();
    const newLeaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);

    const updateResult = await this.prisma.backupBatch.updateMany({
      where: {
        id: batchId,
        OR: [
          { status: 'running', leaseExpiresAt: { lte: now } },
          { status: 'incomplete' },
          { status: 'failed' },
        ],
      },
      data: {
        status: 'running',
        leaseToken: newLeaseToken,
        leaseExpiresAt: newLeaseExpiresAt,
      },
    });

    if (updateResult.count === 0) {
      throw new ConflictException('批次租约竞争失败，已有其他实例在执行重试');
    }

    const updatedBatch = await this.prisma.backupBatch.findUnique({ where: { id: batchId } });
    return this.executeBatchRun(updatedBatch!, newLeaseToken, username);
  }

  async listBackupBatches(query: {
    status?: string;
    periodKey?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (query.status) {
      const allowedStatuses = ['running', 'succeeded', 'incomplete', 'failed'];
      if (!allowedStatuses.includes(query.status)) {
        throw new BadRequestException(`status 参数非法，仅允许: ${allowedStatuses.join(', ')}`);
      }
      where.status = query.status;
    }
    if (query.periodKey) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.periodKey)) {
        throw new BadRequestException('periodKey 参数格式非法，必须为 YYYY-MM (如 2026-09)');
      }
      where.periodKey = query.periodKey;
    }

    const limit = query.limit !== undefined ? Number(query.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit 必须为 1 到 100 之间的整数');
    }

    const offset = query.offset !== undefined ? Number(query.offset) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('offset 必须为大于或等于 0 的整数');
    }

    const [total, items] = await Promise.all([
      this.prisma.backupBatch.count({ where }),
      this.prisma.backupBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);

    return {
      total,
      limit,
      offset,
      items,
    };
  }

  async getBackupBatch(id: string) {
    const batch = await this.prisma.backupBatch.findUnique({ where: { id } });
    if (!batch) {
      throw new NotFoundException(`未找到 ID 为 ${id} 的备份批次`);
    }
    return batch;
  }

  async createArchiveSeasonBackup(username: string, seasonId: string) {
    const backups = await this.objectStore.listBackups();
    const existing = backups.find(
      (backup) =>
        backup.scope === 'module' &&
        backup.module === 'season' &&
        backup.seasonId === seasonId &&
        backup.purpose === 'archive' &&
        backup.protected,
    );
    if (existing) return existing;

    return this.exportService.createBackup(username, {
      scope: 'module',
      module: 'season',
      selector: { seasonId },
      purpose: 'archive',
      protected: true,
    });
  }

  private async resolveScheduledBackupOptions(signal?: AbortSignal): Promise<CreateBackupOptions> {
    const activeSeason = await this.prisma.season.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (activeSeason) {
      return {
        scope: 'module',
        module: 'season',
        selector: { seasonId: activeSeason.id },
        signal,
      };
    }
    return {
      scope: 'module',
      module: 'staff',
      selector: {},
      signal,
    };
  }

  listBackups(options?: { includeUploads?: boolean }) {
    return this.objectStore.listBackups(options);
  }

  getPresignedDownloadUrl(key: string) {
    return this.objectStore.presignGetUrl(key, 300);
  }

  verifyBackupIntegrity(key: string, integrityMap?: Map<string, boolean>) {
    return this.verificationService.verifyBackupIntegrity(key, integrityMap);
  }

  restoreBackup(username: string, key: string, confirmText?: string) {
    return this.restoreService.restoreBackup(username, key, confirmText);
  }

  previewRestore(username: string, key: string) {
    return this.moduleRestoreService.preview(username, key);
  }

  restoreModuleBackup(username: string, key: string, restoreToken: string, confirmText?: string) {
    return this.moduleRestoreService.execute(username, key, restoreToken, confirmText);
  }

  initUpload(userId: string, username: string, filename: string, size: number, fileSha256: string) {
    return this.uploadService.initUpload(userId, username, filename, size, fileSha256);
  }

  completeUpload(userId: string, username: string, uploadToken: string) {
    return this.uploadService.completeUpload(userId, username, uploadToken);
  }

  deleteBackup(username: string, key: string, confirmText?: string) {
    return this.maintenanceService.deleteBackup(username, key, confirmText);
  }

  cleanRetention(username: string, dryRun?: boolean, confirmText?: string) {
    return this.maintenanceService.cleanRetention(username, dryRun, confirmText);
  }
}
