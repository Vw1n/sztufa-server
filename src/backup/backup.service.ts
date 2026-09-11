import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  Logger,
  Optional,
  Inject,
  forwardRef,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID, createHmac, createHash } from 'crypto';
import { BackupExportService, BackupExportException } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupRetentionService } from './backup-retention.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackupMetadata, CreateBackupOptions, HeldLease, BackupRunMetrics } from './backup.types';
import { BackupModuleRestoreService } from './backup-module-restore.service';
import { BackupModule, BACKUP_MODULE_REGISTRY, BACKUP_MODULES } from './backup-module-registry';
import {
  BackupFingerprintService,
  getCanonicalSelectorKey,
  getCanonicalLockKey,
} from './backup-fingerprint.service';
import { BackupRunListQueryDto } from './dto/backup-run-list-query.dto';
import { NeonTrafficService } from './neon-traffic.service';

// 保持既有外部导入兼容性的符号 re-export
export { MANDATORY_BACKUP_TABLES } from './backup-table-registry';
export { validateBackupSchemaAndIntegrity } from './backup-validator';
export type {
  BackupMetadata,
  UploadInitResult,
  CreateBackupOptions,
  HeldLease,
  BackupRunMetrics,
} from './backup.types';
export { getCanonicalSelectorKey, getCanonicalLockKey } from './backup-fingerprint.service';

export const LEASE_TTL_MS = 300_000; // 5 分钟
export const BATCH_TIME_BUDGET_MS = 240_000; // 240 秒
export const MAX_BACKFILL_SEASONS_PER_BATCH = 10;
export const BACKFILL_TOKEN_TTL_MS = 900_000; // 15 分钟
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
      reason:
        | 'no_eligible_season'
        | 'minimum_interval'
        | 'unchanged'
        | 'duplicate_in_flight'
        | 'global_full_in_flight'
        | 'active_module_in_flight'
        | 'already_protected'
        | 'traffic_quota_exceeded';
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

export interface OrchestrateModuleBackupOptions {
  readonly username: string;
  readonly module: BackupModule;
  readonly selector?: Record<string, string>;
  readonly purpose?: 'manual' | 'scheduled' | 'archive' | 'pre-restore' | 'uploaded';
  readonly protected?: boolean;
  readonly trigger?: 'manual' | 'cron' | 'archive' | 'backfill' | 'retry';
  readonly batchId?: string;
  readonly attempts?: number;
  readonly retryOfRunId?: string;
  readonly signal?: AbortSignal;
  readonly heldLease?: HeldLease;
}

export interface OrchestrateFullBackupOptions {
  readonly username: string;
  readonly purpose?: 'manual' | 'scheduled' | 'archive' | 'pre-restore' | 'uploaded';
  readonly protected?: boolean;
  readonly trigger?: 'manual' | 'cron';
  readonly signal?: AbortSignal;
  readonly heldLease?: HeldLease;
}

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
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly exportService: BackupExportService,
    @Inject(forwardRef(() => BackupRestoreService))
    private readonly restoreService: BackupRestoreService,
    private readonly uploadService: BackupUploadService,
    private readonly maintenanceService: BackupMaintenanceService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly scopeService: BackupScopeService,
    private readonly retentionService: BackupRetentionService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BackupModuleRestoreService))
    private readonly moduleRestoreService: BackupModuleRestoreService,
    @Optional()
    private readonly fingerprintService?: BackupFingerprintService,
    @Optional()
    private readonly neonTrafficService?: NeonTrafficService,
  ) {
    if (
      this.restoreService &&
      typeof (this.restoreService as any).setBackupService === 'function'
    ) {
      (this.restoreService as any).setBackupService(this);
    }
    if (
      this.moduleRestoreService &&
      typeof (this.moduleRestoreService as any).setBackupService === 'function'
    ) {
      (this.moduleRestoreService as any).setBackupService(this);
    }
  }

  async onModuleInit() {
    await this.ensureGateRecord().catch((err) => {
      this.logger.warn(`Gate 锁记录自检失败: ${err.message}`);
    });
  }

  async ensureGateRecord(): Promise<void> {
    try {
      await this.prisma.backupLock.upsert({
        where: { lockKey: 'lock:backup:gate' },
        create: { lockKey: 'lock:backup:gate' },
        update: {},
      });
    } catch {
      // 允许在数据库迁移未执行前静默失败
    }
  }

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

  async createBackup(username: string, options?: CreateBackupOptions): Promise<BackupMetadata> {
    const scope = options?.scope || 'full';
    if (scope === 'module') {
      const targetModule = options?.module;
      if (!targetModule) throw new BadRequestException('模块备份必须指定 module');
      const res = await this.orchestrateModuleBackup({
        username,
        module: targetModule,
        selector: options?.selector,
        purpose: options?.purpose,
        protected: options?.protected,
        signal: options?.signal,
        heldLease: options?.heldLease,
      });
      if (res.status === 'created') {
        return res.backup;
      }
      if (res.status === 'skipped') {
        if (res.existingBackup) return res.existingBackup;
        throw new ConflictException(`模块备份已跳过: ${res.reason}`);
      }
      throw new Error(res.error || '模块备份导出失败');
    }

    if (scope === 'season') {
      const seasonId = options?.seasonId || options?.selector?.seasonId;
      if (!seasonId || typeof seasonId !== 'string' || !seasonId.trim()) {
        throw new BadRequestException('分赛季备份必须提供非空 seasonId');
      }
      const targetSeasonId = seasonId.trim();
      const res = await this.orchestrateModuleBackup({
        username,
        module: 'season',
        selector: { ...(options?.selector || {}), seasonId: targetSeasonId },
        purpose: options?.purpose,
        protected: options?.protected,
        signal: options?.signal,
        heldLease: options?.heldLease,
      });
      if (res.status === 'created') {
        return res.backup;
      }
      if (res.status === 'skipped') {
        if (res.existingBackup) return res.existingBackup;
        throw new ConflictException(`赛季备份已跳过: ${res.reason}`);
      }
      throw new Error(res.error || '赛季备份导出失败');
    }

    return this.orchestrateFullBackup({
      username,
      purpose: options?.purpose,
      protected: options?.protected,
      signal: options?.signal,
      heldLease: options?.heldLease,
    });
  }

  async createScheduledBackup(
    username: string,
    options?: CreateBackupOptions,
  ): Promise<ScheduledModuleTaskResult> {
    if (options?.scope === 'full') {
      throw new BadRequestException('定时备份禁止全量备份 (scope=full)');
    }

    let normalizedOptions = options;
    if (normalizedOptions?.scope === 'season') {
      const seasonId = normalizedOptions.seasonId || normalizedOptions.selector?.seasonId;
      if (!seasonId || typeof seasonId !== 'string' || !seasonId.trim()) {
        throw new BadRequestException('分赛季备份必须提供非空 seasonId');
      }
      normalizedOptions = {
        ...normalizedOptions,
        scope: 'module',
        module: 'season',
        selector: { ...(normalizedOptions.selector || {}), seasonId: seasonId.trim() },
      };
    }

    const scheduledOptions: CreateBackupOptions =
      normalizedOptions?.scope === 'module' && normalizedOptions.module
        ? normalizedOptions
        : await this.resolveScheduledBackupOptions(normalizedOptions?.signal);

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

        // 若没有注入指纹服务，保留基于时间戳的降级变化检测
        if (
          !this.fingerprintService &&
          process.env.SCHEDULED_BACKUP_CHANGE_DETECTION_ENABLED !== 'false'
        ) {
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

    // 若启用了指纹服务，通过 orchestrateModuleBackup 统一执行
    if (this.fingerprintService) {
      return this.orchestrateModuleBackup({
        username,
        module: targetModule,
        selector,
        purpose: 'scheduled',
        trigger: 'cron',
        signal: scheduledOptions.signal,
      });
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

  private getBackfillSecret(): string {
    const secret = process.env.BACKUP_BACKFILL_TOKEN_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('生产环境缺少必要的环境变量: BACKUP_BACKFILL_TOKEN_SECRET');
      }
      return 'dev-insecure-backup-backfill-secret';
    }
    return secret;
  }

  private generateBackfillToken(operatorId: string, seasonIds: string[]): string {
    const sorted = [...seasonIds].sort();
    const seasonIdsHash = createHash('sha256').update(sorted.join(',')).digest('hex');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + BACKFILL_TOKEN_TTL_MS;
    const payload = JSON.stringify({
      operatorId,
      seasonIds: sorted,
      seasonIdsHash,
      issuedAt,
      expiresAt,
    });
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.getBackfillSecret())
      .update(payloadB64)
      .digest('base64url');
    return `${payloadB64}.${signature}`;
  }

  verifyBackfillToken(
    token: string,
    operatorId: string,
  ): { seasonIds: string[]; expiresAt: number } {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('无效的预检凭据 (backfillToken 缺失)');
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new BadRequestException('无效的预检凭据格式');
    }
    const [payloadB64, signature] = parts;
    const expectedSignature = createHmac('sha256', this.getBackfillSecret())
      .update(payloadB64)
      .digest('base64url');
    if (signature !== expectedSignature) {
      throw new BadRequestException('预检凭据签名无效或已被篡改');
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (Date.now() > payload.expiresAt) {
        throw new BadRequestException('预检凭据已过期，请重新发起预检');
      }
      if (payload.operatorId !== operatorId) {
        throw new BadRequestException('预检凭据与当前操作管理员不匹配');
      }
      const sorted = [...payload.seasonIds].sort();
      const checkHash = createHash('sha256').update(sorted.join(',')).digest('hex');
      if (payload.seasonIdsHash !== checkHash) {
        throw new BadRequestException('预检凭据数据摘要不一致');
      }
      return { seasonIds: payload.seasonIds, expiresAt: payload.expiresAt };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('预检凭据解析失败');
    }
  }

  async acquireLock(
    lockKey: string,
    instanceId: string,
    ttlMs: number = LEASE_TTL_MS,
  ): Promise<{ acquired: boolean; leaseToken?: string }> {
    const leaseToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + ttlMs);

    try {
      const lock = await this.prisma.backupLock.create({
        data: {
          lockKey,
          leaseToken,
          leaseExpiresAt,
          holderInstance: instanceId,
        },
      });
      return { acquired: true, leaseToken: lock.leaseToken! };
    } catch (err: any) {
      if (err.code !== 'P2002') throw err;
    }

    const updateResult = await this.prisma.backupLock.updateMany({
      where: {
        lockKey,
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseToken: null }, { leaseExpiresAt: null }],
      },
      data: {
        leaseToken,
        leaseExpiresAt,
        holderInstance: instanceId,
      },
    });

    if (updateResult.count > 0) {
      return { acquired: true, leaseToken };
    }
    return { acquired: false };
  }

  async releaseLock(lockKey: string, leaseToken: string): Promise<boolean> {
    const result = await this.prisma.backupLock.updateMany({
      where: {
        lockKey,
        leaseToken,
      },
      data: {
        leaseToken: null,
        leaseExpiresAt: null,
        holderInstance: null,
      },
    });
    return result.count > 0;
  }

  async checkLockOwnership(lockKey: string, leaseToken: string): Promise<boolean> {
    const lock = await this.prisma.backupLock.findFirst({
      where: {
        lockKey,
        leaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    return !!lock;
  }

  async acquireBackupLock(
    type: 'module' | 'full',
    lockKey: string,
    instanceId: string,
    ttlMs: number = LEASE_TTL_MS,
  ): Promise<
    | { acquired: true; leaseToken: string }
    | {
        acquired: false;
        reason: 'duplicate_in_flight' | 'global_full_in_flight' | 'active_module_in_flight';
      }
  > {
    return this.prisma.$transaction(async (tx) => {
      const gate = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BackupLock" WHERE "lockKey" = 'lock:backup:gate' FOR UPDATE
      `;
      if (!gate || gate.length === 0) {
        throw new ServiceUnavailableException('备份仲裁系统异常: Gate 锁记录缺失 (fail-closed)');
      }

      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + ttlMs);
      const leaseToken = randomUUID();

      if (type === 'full') {
        const curFull = await tx.backupLock.findUnique({
          where: { lockKey: 'lock:backup:global:full' },
        });
        if (
          curFull &&
          curFull.leaseExpiresAt &&
          curFull.leaseExpiresAt > now &&
          curFull.leaseToken
        ) {
          return { acquired: false, reason: 'duplicate_in_flight' };
        }
        const activeModules = await tx.backupLock.count({
          where: {
            lockKey: {
              startsWith: 'lock:backup:',
              notIn: ['lock:backup:gate', 'lock:backup:global:full'],
            },
            leaseExpiresAt: { gt: now },
            leaseToken: { not: null },
          },
        });
        if (activeModules > 0) {
          return { acquired: false, reason: 'active_module_in_flight' };
        }

        await tx.backupLock.upsert({
          where: { lockKey: 'lock:backup:global:full' },
          create: {
            lockKey: 'lock:backup:global:full',
            leaseToken,
            leaseExpiresAt,
            holderInstance: instanceId,
          },
          update: {
            leaseToken,
            leaseExpiresAt,
            holderInstance: instanceId,
          },
        });
        return { acquired: true, leaseToken };
      } else {
        const activeFull = await tx.backupLock.findFirst({
          where: {
            lockKey: 'lock:backup:global:full',
            leaseExpiresAt: { gt: now },
            leaseToken: { not: null },
          },
        });
        if (activeFull) {
          return { acquired: false, reason: 'global_full_in_flight' };
        }

        const cur = await tx.backupLock.findUnique({ where: { lockKey } });
        if (cur && cur.leaseExpiresAt && cur.leaseExpiresAt > now && cur.leaseToken) {
          return { acquired: false, reason: 'duplicate_in_flight' };
        }

        await tx.backupLock.upsert({
          where: { lockKey },
          create: {
            lockKey,
            leaseToken,
            leaseExpiresAt,
            holderInstance: instanceId,
          },
          update: {
            leaseToken,
            leaseExpiresAt,
            holderInstance: instanceId,
          },
        });
        return { acquired: true, leaseToken };
      }
    });
  }

  startHeartbeat(
    heldLease: { lockKey: string; leaseToken: string },
    abortController: AbortController,
    intervalMs = 20000,
  ): NodeJS.Timeout {
    let isHeartbeatInFlight = false;
    return setInterval(async () => {
      if (isHeartbeatInFlight) return;
      isHeartbeatInFlight = true;
      try {
        const now = new Date();
        const renew = await this.prisma.backupLock.updateMany({
          where: {
            lockKey: heldLease.lockKey,
            leaseToken: heldLease.leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
        });
        if (renew.count === 0) {
          abortController.abort();
        }
      } catch {
        // 忽略单次网络闪断
      } finally {
        isHeartbeatInFlight = false;
      }
    }, intervalMs);
  }

  async orchestrateModuleBackup(
    options: OrchestrateModuleBackupOptions,
  ): Promise<ScheduledModuleTaskResult> {
    const module = options.module;
    if (!BACKUP_MODULES.includes(module)) {
      throw new BadRequestException(`非法的模块名称: ${module}`);
    }
    const selector = options.selector || {};
    const canonicalSelectorKey = getCanonicalSelectorKey(module, selector);
    const canonicalLockKey = getCanonicalLockKey(module, selector);
    const purpose = options.purpose || 'manual';
    const trigger =
      options.trigger ||
      (purpose === 'scheduled' ? 'cron' : purpose === 'archive' ? 'archive' : 'manual');

    let leaseToken: string;
    let isExternalLock = false;

    if (options.heldLease) {
      if (options.heldLease.lockKey !== canonicalLockKey) {
        throw new BadRequestException(
          `模块 HeldLease lockKey 不匹配: 期望 ${canonicalLockKey}, 实际 ${options.heldLease.lockKey}`,
        );
      }
      const lockRecord = await this.prisma.backupLock.findFirst({
        where: {
          lockKey: canonicalLockKey,
          leaseToken: options.heldLease.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (!lockRecord) {
        throw new ConflictException('模块 HeldLease 租约已失效或不存在');
      }
      leaseToken = options.heldLease.leaseToken;
      isExternalLock = true;
    } else {
      const instanceId = randomUUID();
      const lockRes = await this.acquireBackupLock('module', canonicalLockKey, instanceId);
      if (!lockRes.acquired) {
        const skipReason: any = (lockRes as any).reason;
        return {
          status: 'skipped',
          module,
          selector,
          reason: skipReason,
          finishedAt: new Date().toISOString(),
        };
      }
      leaseToken = lockRes.leaseToken;
    }

    const internalAbort = new AbortController();
    const onExternalAbort = () => internalAbort.abort();
    if (options.signal) {
      if (options.signal.aborted) internalAbort.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let heartbeatTimer: NodeJS.Timeout | null = null;
    if (!isExternalLock) {
      heartbeatTimer = this.startHeartbeat(
        { lockKey: canonicalLockKey, leaseToken },
        internalAbort,
      );
    }

    const taskKey =
      purpose === 'archive' && selector?.seasonId && trigger !== 'retry'
        ? `archive:season:${selector.seasonId}`
        : undefined;

    let backupRun: any;
    let currentAttempts = options.attempts || 1;
    if (taskKey) {
      const existing = await this.prisma.backupRun.findUnique({ where: { taskKey } });
      currentAttempts = options.attempts || (existing?.attempts || 0) + 1;
      backupRun = await this.prisma.backupRun.upsert({
        where: { taskKey },
        create: {
          batchId: options.batchId || null,
          taskKey,
          trigger,
          scope: 'module',
          module,
          selectorKey: canonicalSelectorKey,
          purpose,
          status: 'running',
          leaseToken,
          attempts: currentAttempts,
          startedAt: new Date(),
        },
        update: {
          batchId: options.batchId || null,
          trigger,
          status: 'running',
          leaseToken,
          attempts: currentAttempts,
          startedAt: new Date(),
          failureCode: null,
          failureMessage: null,
        },
      });
    } else {
      backupRun = await this.prisma.backupRun.create({
        data: {
          batchId: options.batchId || null,
          trigger,
          scope: 'module',
          module,
          selectorKey: canonicalSelectorKey,
          purpose,
          status: 'running',
          leaseToken,
          attempts: currentAttempts,
          startedAt: new Date(),
        },
      });
    }

    const startExport = Date.now();
    let createdBackupKey: string | null = null;
    let committedSuccess = false;

    try {
      let fpBefore: any = null;
      if (this.fingerprintService) {
        fpBefore = await this.fingerprintService.calculateModuleFingerprint(module, selector);
        await this.prisma.backupRun
          .updateMany({
            where: { id: backupRun.id, leaseToken },
            data: { fingerprintBefore: fpBefore.fingerprint },
          })
          .catch(() => {});
      }

      // 仅在 scheduled 时做 Checkpoint 对比跳过 (pre-restore 快照绝不可跳过)
      if (purpose === 'scheduled' && fpBefore) {
        const checkpoint = await this.prisma.backupModuleCheckpoint.findUnique({
          where: { module_selectorKey: { module, selectorKey: canonicalSelectorKey } },
        });

        if (
          checkpoint &&
          checkpoint.fingerprint === fpBefore.fingerprint &&
          checkpoint.lastSuccessfulBackupKey
        ) {
          // unchanged 分支持锁原子更新 Checkpoint 与 BackupRun
          await this.prisma.$transaction(async (tx) => {
            const now = new Date();
            const lockCas = await tx.backupLock.updateMany({
              where: {
                lockKey: canonicalLockKey,
                leaseToken,
                leaseExpiresAt: { gt: now },
              },
              data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
            });
            if (lockCas.count === 0) {
              throw new Error('租约在指纹检测期间失效 (fencing check failed)');
            }

            await tx.backupModuleCheckpoint.update({
              where: { id: checkpoint.id },
              data: { lastObservedAt: now },
            });

            const runCas = await tx.backupRun.updateMany({
              where: { id: backupRun.id, leaseToken },
              data: {
                status: 'skipped',
                skipReason: 'unchanged',
                fingerprintBefore: fpBefore.fingerprint,
                fingerprintAfter: fpBefore.fingerprint,
                finishedAt: now,
              },
            });
            if (runCas.count === 0) {
              throw new Error('BackupRun 租约丢失 (fencing check failed)');
            }
          });

          committedSuccess = true;
          return {
            status: 'skipped',
            module,
            selector,
            reason: 'unchanged',
            finishedAt: new Date().toISOString(),
          };
        }
      }
      // 针对归档赛季的配额守卫检查：达到 4GB 红色预警时暂停非必要重备份，缺失保护备份的必要补缺仍继续执行
      if (purpose === 'archive' && trigger !== 'manual' && selector?.seasonId) {
        const quotaCheck = await this.isNeonOfficialQuotaExceeded();
        if (quotaCheck.exceeded) {
          const hasProtected = await this.hasValidProtectedBackupForSeason(selector.seasonId);
          if (hasProtected) {
            await this.recordAuditLog(
              options.username,
              'AUDIT_TRAFFIC_QUOTA_EXCEEDED',
              `Neon 官方流量已达 4GB 红色阈值，暂停赛季 ${selector.seasonId} 的非必要归档重备份`,
            );
            await this.prisma.backupRun.updateMany({
              where: { id: backupRun.id, leaseToken },
              data: {
                status: 'skipped',
                skipReason: 'traffic_quota_exceeded',
                finishedAt: new Date(),
              },
            });
            committedSuccess = true;
            return {
              status: 'skipped',
              module,
              selector,
              reason: 'traffic_quota_exceeded',
              finishedAt: new Date().toISOString(),
            };
          } else {
            await this.recordAuditLog(
              options.username,
              'EMERGENCY_ARCHIVE_BACKFILL_UNDER_QUOTA',
              `Neon 官方流量已达 4GB 红色阈值，但赛季 ${selector.seasonId} 缺失受保护备份，执行紧急必要补缺`,
            );
          }
        }
      }

      // 执行导出与上传
      const backupMetadata = await this.exportService.createBackup(options.username, {
        scope: 'module',
        module,
        selector,
        purpose,
        protected: options.protected,
        signal: internalAbort.signal,
      });
      createdBackupKey = backupMetadata.key;

      // 二次采样指纹 (Conservative Snapshot Consistency)
      let fpAfter: any = fpBefore;
      if (this.fingerprintService) {
        fpAfter = await this.fingerprintService.calculateModuleFingerprint(module, selector);
      }

      const isFingerprintConsistent =
        fpBefore && fpAfter && fpBefore.fingerprint === fpAfter.fingerprint;

      // 事务内 CAS 校验租约有效性并提交终态
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const lockCas = await tx.backupLock.updateMany({
          where: {
            lockKey: canonicalLockKey,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
          },
        });
        if (lockCas.count === 0) {
          throw new Error('租约在导出期间已失效或被接管 (fencing check failed)');
        }

        const runCas = await tx.backupRun.updateMany({
          where: { id: backupRun.id, leaseToken },
          data: {
            status: 'succeeded',
            backupKey: backupMetadata.key,
            checksum: backupMetadata.checksum,
            objectSize: BigInt(backupMetadata.size),
            fingerprintBefore: fpBefore?.fingerprint || null,
            fingerprintAfter: fpAfter?.fingerprint || null,
            durationMs: Date.now() - startExport,
            databaseBytesEstimated:
              backupMetadata.databaseBytesEstimated !== null &&
              backupMetadata.databaseBytesEstimated !== undefined
                ? BigInt(backupMetadata.databaseBytesEstimated)
                : null,
            uncompressedBytes:
              backupMetadata.uncompressedBytes !== null &&
              backupMetadata.uncompressedBytes !== undefined
                ? BigInt(backupMetadata.uncompressedBytes)
                : null,
            databaseRowsRead:
              backupMetadata.databaseRowsRead !== null &&
              backupMetadata.databaseRowsRead !== undefined
                ? backupMetadata.databaseRowsRead
                : null,
            uploadedBytes:
              backupMetadata.uploadedBytes !== null && backupMetadata.uploadedBytes !== undefined
                ? BigInt(backupMetadata.uploadedBytes)
                : null,
            peakRssBytes:
              backupMetadata.peakRssBytes !== null && backupMetadata.peakRssBytes !== undefined
                ? BigInt(backupMetadata.peakRssBytes)
                : null,
            verifiedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        if (runCas.count === 0) {
          throw new Error('BackupRun 租约所有权已丢失 (fencing check failed)');
        }

        // 保守一致性：仅当前后指纹完全相同时才推进 Checkpoint 基线
        if (isFingerprintConsistent) {
          await tx.backupModuleCheckpoint.upsert({
            where: { module_selectorKey: { module, selectorKey: canonicalSelectorKey } },
            create: {
              module,
              selectorKey: canonicalSelectorKey,
              fingerprint: fpAfter.fingerprint,
              fingerprintVersion: fpAfter.version,
              lastSuccessfulBackupKey: backupMetadata.key,
              lastSuccessfulAt: new Date(),
              lastObservedAt: new Date(),
            },
            update: {
              fingerprint: fpAfter.fingerprint,
              fingerprintVersion: fpAfter.version,
              lastSuccessfulBackupKey: backupMetadata.key,
              lastSuccessfulAt: new Date(),
              lastObservedAt: new Date(),
            },
          });
        }
      });

      committedSuccess = true;
      return {
        status: 'created',
        module,
        selector,
        backup: backupMetadata,
        durationMs: Date.now() - startExport,
        finishedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      if (createdBackupKey && !committedSuccess) {
        await this.objectStore.deleteObject(createdBackupKey).catch(() => {});
      }

      const isAborted =
        options.signal?.aborted ||
        internalAbort.signal.aborted ||
        err.name === 'AbortError' ||
        err.message?.includes('aborted');

      const partial = err instanceof BackupExportException ? err.partialMetrics : null;

      await this.prisma.backupRun
        .updateMany({
          where: { id: backupRun.id, leaseToken },
          data: {
            status: 'failed',
            failureCode: isAborted ? 'TIME_BUDGET_EXHAUSTED' : err.name || 'BACKUP_FAILED',
            failureMessage: (err.message || String(err)).slice(0, 1000),
            databaseBytesEstimated:
              partial?.databaseBytesEstimated !== null &&
              partial?.databaseBytesEstimated !== undefined
                ? BigInt(partial.databaseBytesEstimated)
                : null,
            uncompressedBytes:
              partial?.uncompressedBytes !== null && partial?.uncompressedBytes !== undefined
                ? BigInt(partial.uncompressedBytes)
                : null,
            databaseRowsRead:
              partial?.databaseRowsRead !== null && partial?.databaseRowsRead !== undefined
                ? partial.databaseRowsRead
                : null,
            uploadedBytes: null, // 上传失败或已删除，严禁记为 0，必须记为 null
            peakRssBytes:
              partial?.peakRssBytes !== null && partial?.peakRssBytes !== undefined
                ? BigInt(partial.peakRssBytes)
                : null,
            durationMs: Date.now() - startExport,
            finishedAt: new Date(),
          },
        })
        .catch(() => {});

      if (isAborted) {
        return {
          status: 'failed',
          module,
          selector,
          reason: 'time_budget_exhausted',
          error: '执行预算耗尽，已安全中止',
          finishedAt: new Date().toISOString(),
        };
      }

      return {
        status: 'failed',
        module,
        selector,
        reason: 'export_error',
        error: err.message || '模块备份导出异常',
        finishedAt: new Date().toISOString(),
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
      if (!isExternalLock) {
        await this.releaseLock(canonicalLockKey, leaseToken).catch(() => {});
      }
    }
  }

  async orchestrateFullBackup(options: OrchestrateFullBackupOptions): Promise<BackupMetadata> {
    const purpose = options.purpose || 'manual';
    const trigger = options.trigger || 'manual';

    let leaseToken: string;
    let isExternalLock = false;

    if (options.heldLease) {
      if (options.heldLease.lockKey !== 'lock:backup:global:full') {
        throw new BadRequestException(
          `全量 HeldLease lockKey 不匹配: 期望 lock:backup:global:full, 实际 ${options.heldLease.lockKey}`,
        );
      }
      const lockRecord = await this.prisma.backupLock.findFirst({
        where: {
          lockKey: 'lock:backup:global:full',
          leaseToken: options.heldLease.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (!lockRecord) {
        throw new ConflictException('全量 HeldLease 租约已失效或不存在');
      }
      leaseToken = options.heldLease.leaseToken;
      isExternalLock = true;
    } else {
      const instanceId = randomUUID();
      const lockRes = await this.acquireBackupLock('full', 'lock:backup:global:full', instanceId);
      if (!lockRes.acquired) {
        throw new ConflictException(`全量备份锁申请失败: ${(lockRes as any).reason}`);
      }
      leaseToken = lockRes.leaseToken;
    }

    const internalAbort = new AbortController();
    const onExternalAbort = () => internalAbort.abort();
    if (options.signal) {
      if (options.signal.aborted) internalAbort.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let heartbeatTimer: NodeJS.Timeout | null = null;
    if (!isExternalLock) {
      heartbeatTimer = this.startHeartbeat(
        { lockKey: 'lock:backup:global:full', leaseToken },
        internalAbort,
      );
    }

    const backupRun = await this.prisma.backupRun.create({
      data: {
        trigger,
        scope: 'full',
        module: 'full',
        selectorKey: 'global',
        purpose,
        status: 'running',
        leaseToken,
        attempts: 1,
        startedAt: new Date(),
      },
    });

    const startExport = Date.now();
    let createdBackupKey: string | null = null;
    let committedSuccess = false;

    try {
      const backup = await this.exportService.createBackup(options.username, {
        scope: 'full',
        purpose,
        protected: options.protected,
        signal: internalAbort.signal,
      });
      createdBackupKey = backup.key;

      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const lockCas = await tx.backupLock.updateMany({
          where: {
            lockKey: 'lock:backup:global:full',
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
          },
        });
        if (lockCas.count === 0) {
          throw new Error('全量备份租约在导出期间已失效或被接管 (fencing check failed)');
        }

        const runCas = await tx.backupRun.updateMany({
          where: { id: backupRun.id, leaseToken },
          data: {
            status: 'succeeded',
            backupKey: backup.key,
            checksum: backup.checksum,
            objectSize: BigInt(backup.size),
            durationMs: Date.now() - startExport,
            databaseBytesEstimated:
              backup.databaseBytesEstimated !== null && backup.databaseBytesEstimated !== undefined
                ? BigInt(backup.databaseBytesEstimated)
                : null,
            uncompressedBytes:
              backup.uncompressedBytes !== null && backup.uncompressedBytes !== undefined
                ? BigInt(backup.uncompressedBytes)
                : null,
            databaseRowsRead:
              backup.databaseRowsRead !== null && backup.databaseRowsRead !== undefined
                ? backup.databaseRowsRead
                : null,
            uploadedBytes:
              backup.uploadedBytes !== null && backup.uploadedBytes !== undefined
                ? BigInt(backup.uploadedBytes)
                : null,
            peakRssBytes:
              backup.peakRssBytes !== null && backup.peakRssBytes !== undefined
                ? BigInt(backup.peakRssBytes)
                : null,
            verifiedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        if (runCas.count === 0) {
          throw new Error('BackupRun 租约所有权已丢失 (fencing check failed)');
        }
      });

      committedSuccess = true;
      return backup;
    } catch (err: any) {
      if (createdBackupKey && !committedSuccess) {
        await this.objectStore.deleteObject(createdBackupKey).catch(() => {});
      }

      const partial = err instanceof BackupExportException ? err.partialMetrics : null;

      await this.prisma.backupRun
        .updateMany({
          where: { id: backupRun.id, leaseToken },
          data: {
            status: 'failed',
            failureCode: err.name || 'FULL_BACKUP_FAILED',
            failureMessage: (err.message || String(err)).slice(0, 1000),
            databaseBytesEstimated:
              partial?.databaseBytesEstimated !== null &&
              partial?.databaseBytesEstimated !== undefined
                ? BigInt(partial.databaseBytesEstimated)
                : null,
            uncompressedBytes:
              partial?.uncompressedBytes !== null && partial?.uncompressedBytes !== undefined
                ? BigInt(partial.uncompressedBytes)
                : null,
            databaseRowsRead:
              partial?.databaseRowsRead !== null && partial?.databaseRowsRead !== undefined
                ? partial.databaseRowsRead
                : null,
            uploadedBytes: null,
            peakRssBytes:
              partial?.peakRssBytes !== null && partial?.peakRssBytes !== undefined
                ? BigInt(partial.peakRssBytes)
                : null,
            durationMs: Date.now() - startExport,
            finishedAt: new Date(),
          },
        })
        .catch(() => {});
      throw err;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
      if (!isExternalLock) {
        await this.releaseLock('lock:backup:global:full', leaseToken).catch(() => {});
      }
    }
  }

  async scanArchiveCoverage(): Promise<{
    total: number;
    protected: number;
    missing: number;
    corrupt: number;
    seasons: Array<{
      id: string;
      name: string;
      archivedAt: Date | null;
      hasProtectedBackup: boolean;
      isCorrupt: boolean;
      backupKey: string | null;
      objectSize: number | null;
      verifiedAt: Date | null;
      lastError: string | null;
    }>;
  }> {
    const archivedSeasons = await this.prisma.season.findMany({
      where: { status: 'archived' },
      select: { id: true, name: true, archivedAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const [allBackups, allRuns] = await Promise.all([
      this.objectStore.listBackups(),
      this.prisma.backupRun.findMany({
        where: {
          module: 'season',
          purpose: 'archive',
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const runMap = new Map<string, (typeof allRuns)[0]>();
    for (const run of allRuns) {
      if (!runMap.has(run.selectorKey)) {
        runMap.set(run.selectorKey, run);
      }
    }

    const seasonsResult: any[] = [];
    let protectedCount = 0;
    let missingCount = 0;
    let corruptCount = 0;

    for (const season of archivedSeasons) {
      const selectorKey = `season:${season.id}`;
      const latestRun = runMap.get(selectorKey);

      const candidateBackups = allBackups.filter(
        (b) =>
          b.scope === 'module' &&
          b.module === 'season' &&
          b.seasonId === season.id &&
          b.purpose === 'archive' &&
          b.protected,
      );

      let isProtected = false;
      let isCorrupt = false;
      let validKey: string | null = null;
      let validSize: number | null = null;
      let verifiedAt: Date | null = null;
      let lastError: string | null = latestRun?.failureMessage || null;

      if (latestRun && latestRun.status === 'succeeded' && latestRun.backupKey) {
        try {
          const actualSize = await this.objectStore.headObject(latestRun.backupKey);
          if (actualSize <= 0) {
            isCorrupt = true;
            lastError = '受保护备份对象大小异常 (0字节)';
          } else if (
            latestRun.checksum &&
            latestRun.objectSize !== null &&
            latestRun.objectSize !== undefined
          ) {
            const expectedSize = Number(latestRun.objectSize);
            if (actualSize !== expectedSize) {
              isCorrupt = true;
              lastError = `受保护对象大小不匹配 (预期 ${expectedSize} 字节，实际 ${actualSize} 字节，对象可能被截断)`;
            } else {
              isProtected = true;
              validKey = latestRun.backupKey;
              validSize = actualSize;
              verifiedAt = latestRun.verifiedAt || latestRun.finishedAt || new Date();
            }
          } else {
            // 缺少 checksum 或 objectSize (旧记录或非标准记录)，执行详细完整性流式校验并提取 checksum
            const inspectRes = await this.verificationService.inspectAndVerifyBackup(
              latestRun.backupKey,
            );
            if (inspectRes.valid) {
              isProtected = true;
              validKey = latestRun.backupKey;
              validSize = actualSize;
              verifiedAt = new Date();
              await this.prisma.backupRun
                .update({
                  where: { id: latestRun.id },
                  data: {
                    checksum: inspectRes.checksum || null,
                    objectSize: BigInt(actualSize),
                    verifiedAt: new Date(),
                  },
                })
                .catch(() => {});
            } else {
              isCorrupt = true;
              lastError = inspectRes.error || '受保护对象完整性流式校验失败或校验和不匹配';
            }
          }
        } catch {
          isCorrupt = true;
          lastError = '受保护备份记录对应的云端对象不存在或无法读取';
        }
      } else if (candidateBackups.length > 0) {
        // 同一赛季可能存在多个受保护归档对象，按时间由新到旧排序逐个校验
        const sortedCandidates = [...candidateBackups].sort((a, b) => {
          const tA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const tB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          return tB - tA;
        });

        const failureDetails: string[] = [];

        for (const candidate of sortedCandidates) {
          try {
            const actualSize = await this.objectStore.headObject(candidate.key);
            if (actualSize <= 0) {
              failureDetails.push(`${candidate.filename}: 对象大小为 0 字节`);
              continue;
            }
            const inspectRes = await this.verificationService.inspectAndVerifyBackup(candidate.key);
            if (inspectRes.valid) {
              isProtected = true;
              isCorrupt = false;
              lastError = null;
              validKey = candidate.key;
              validSize = actualSize;
              verifiedAt = new Date();
              await this.prisma.backupRun.upsert({
                where: { taskKey: `archive:season:${season.id}` },
                create: {
                  taskKey: `archive:season:${season.id}`,
                  trigger: 'archive',
                  scope: 'module',
                  module: 'season',
                  selectorKey,
                  purpose: 'archive',
                  status: 'succeeded',
                  backupKey: candidate.key,
                  checksum: inspectRes.checksum || null,
                  objectSize: BigInt(actualSize),
                  verifiedAt: new Date(),
                  finishedAt: new Date(),
                },
                update: {
                  status: 'succeeded',
                  backupKey: candidate.key,
                  checksum: inspectRes.checksum || null,
                  objectSize: BigInt(actualSize),
                  verifiedAt: new Date(),
                  finishedAt: new Date(),
                },
              });
              break; // 命中首个有效对象即停止后续重试
            } else {
              failureDetails.push(
                `${candidate.filename}: ${inspectRes.error || '完整性流式校验失败'}`,
              );
            }
          } catch (err: any) {
            failureDetails.push(`${candidate.filename}: ${err.message || '对象不可读取'}`);
          }
        }

        // 若所有候选对象均校验失败，才标记为损坏
        if (!isProtected && failureDetails.length > 0) {
          isCorrupt = true;
          lastError = `云端 ${failureDetails.length} 个候选保护备份均校验失败: ${failureDetails.join('; ')}`;
        }
      }

      if (isProtected) {
        protectedCount++;
      } else if (isCorrupt) {
        corruptCount++;
      } else {
        missingCount++;
      }

      seasonsResult.push({
        id: season.id,
        name: season.name,
        archivedAt: season.archivedAt,
        hasProtectedBackup: isProtected,
        isCorrupt,
        backupKey: validKey,
        objectSize: validSize,
        verifiedAt,
        lastError,
      });
    }

    return {
      total: archivedSeasons.length,
      protected: protectedCount,
      missing: missingCount,
      corrupt: corruptCount,
      seasons: seasonsResult,
    };
  }

  async previewArchiveBackfill(
    operatorId: string,
    seasonIds?: string[],
  ): Promise<{
    missingSeasons: Array<{ id: string; name: string; archivedAt: Date | null }>;
    affectedTables: readonly string[];
    estimatedRows: null;
    estimatedBytes: null;
    notice: string;
    backfillToken: string;
  }> {
    const coverage = await this.scanArchiveCoverage();
    let targetSeasons = coverage.seasons.filter((s) => !s.hasProtectedBackup);

    if (seasonIds && seasonIds.length > 0) {
      if (seasonIds.length > MAX_BACKFILL_SEASONS_PER_BATCH) {
        throw new BadRequestException(
          `单次补建赛季数量不能超过 ${MAX_BACKFILL_SEASONS_PER_BATCH} 个，请分批选择`,
        );
      }
      const requestedSet = new Set(seasonIds);
      targetSeasons = targetSeasons.filter((s) => requestedSet.has(s.id));
    } else if (targetSeasons.length > MAX_BACKFILL_SEASONS_PER_BATCH) {
      targetSeasons = targetSeasons.slice(0, MAX_BACKFILL_SEASONS_PER_BATCH);
    }

    const backfillToken = this.generateBackfillToken(
      operatorId,
      targetSeasons.map((s) => s.id),
    );

    return {
      missingSeasons: targetSeasons.map((s) => ({
        id: s.id,
        name: s.name,
        archivedAt: s.archivedAt,
      })),
      affectedTables: [
        ...BACKUP_MODULE_REGISTRY['season'].ownedTables,
        ...BACKUP_MODULE_REGISTRY['season'].referenceTables,
      ],
      estimatedRows: null,
      estimatedBytes: null,
      notice:
        '为严格遵守低流量与保护 Neon 出口原则，Preview 不对业务表执行预读 COUNT。实际行数与字节数将在流式导出时累加记录。',
      backfillToken,
    };
  }

  async executeArchiveBackfill(
    operatorId: string,
    username: string,
    backfillToken: string,
    seasonIds?: string[],
  ): Promise<{
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
    items: Array<{
      seasonId: string;
      status: 'succeeded' | 'skipped' | 'failed';
      reason?: string;
      backupKey?: string;
      error?: string;
    }>;
  }> {
    const verified = this.verifyBackfillToken(backfillToken, operatorId);
    const allowedSet = new Set(verified.seasonIds);

    const targetIds = seasonIds && seasonIds.length > 0 ? seasonIds : verified.seasonIds;
    if (targetIds.length > MAX_BACKFILL_SEASONS_PER_BATCH) {
      throw new BadRequestException(
        `单次补建赛季数量超过最大上限 ${MAX_BACKFILL_SEASONS_PER_BATCH} 个`,
      );
    }
    for (const sid of targetIds) {
      if (!allowedSet.has(sid)) {
        throw new BadRequestException(`赛季 ID ${sid} 不在当前预检凭据许可范围内`);
      }
    }

    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      abortController.abort();
    }, BATCH_TIME_BUDGET_MS);

    const items: any[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    try {
      for (const seasonId of targetIds) {
        if (abortController.signal.aborted) {
          items.push({
            seasonId,
            status: 'skipped',
            reason: 'time_budget_exhausted',
          });
          skipped++;
          continue;
        }

        const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
        if (!season || season.status !== 'archived') {
          items.push({
            seasonId,
            status: 'failed',
            error: '目标赛季不存在或当前状态非已归档 (archived)',
          });
          failed++;
          continue;
        }

        const latestRun = await this.prisma.backupRun.findFirst({
          where: { selectorKey: `season:${seasonId}`, purpose: 'archive' },
          orderBy: { createdAt: 'desc' },
        });

        if (
          latestRun?.status === 'failed' &&
          latestRun.nextAttemptAt &&
          latestRun.nextAttemptAt > new Date()
        ) {
          items.push({
            seasonId,
            status: 'skipped',
            reason: 'backing_off',
          });
          skipped++;
          continue;
        }

        const singleResult = await this.executeArchiveSeasonBackupWithLock(
          username,
          seasonId,
          'backfill',
          abortController.signal,
        );

        if (singleResult.status === 'succeeded') {
          succeeded++;
        } else if (singleResult.status === 'skipped') {
          skipped++;
        } else {
          failed++;
        }
        items.push(singleResult);
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    return {
      total: targetIds.length,
      succeeded,
      skipped,
      failed,
      items,
    };
  }

  async retryArchiveSeasonBackfill(
    seasonId: string,
    username: string,
  ): Promise<{
    seasonId: string;
    status: 'succeeded' | 'skipped' | 'failed';
    reason?: string;
    backupKey?: string;
    error?: string;
  }> {
    const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!season || season.status !== 'archived') {
      throw new BadRequestException('仅状态为已归档 (archived) 的赛季允许进行归档重试');
    }

    const latestRun = await this.prisma.backupRun.findFirst({
      where: { selectorKey: `season:${seasonId}`, purpose: 'archive' },
      orderBy: { createdAt: 'desc' },
    });
    if (
      latestRun?.status === 'failed' &&
      latestRun.nextAttemptAt &&
      latestRun.nextAttemptAt > new Date()
    ) {
      const waitSeconds = Math.ceil((latestRun.nextAttemptAt.getTime() - Date.now()) / 1000);
      throw new BadRequestException(
        `当前赛季归档备份处于退避重试冷却期，请在 ${waitSeconds} 秒后再试 (冷却截止: ${latestRun.nextAttemptAt.toISOString()})`,
      );
    }

    return this.executeArchiveSeasonBackupWithLock(username, seasonId, 'retry');
  }

  async executePendingArchiveBackup(
    seasonId: string,
    username: string,
  ): Promise<{
    seasonId: string;
    status: 'succeeded' | 'skipped' | 'failed';
    reason?: string;
    backupKey?: string;
    error?: string;
  }> {
    const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!season || season.status !== 'archived') {
      return {
        seasonId,
        status: 'skipped',
        reason: 'season_not_archived',
      };
    }
    return this.executeArchiveSeasonBackupWithLock(username, seasonId, 'archive');
  }

  async hasValidProtectedBackupForSeason(seasonId: string): Promise<boolean> {
    const allBackups = await this.objectStore.listBackups();
    const existingCandidates = allBackups.filter(
      (b) =>
        b.scope === 'module' &&
        b.module === 'season' &&
        b.seasonId === seasonId &&
        b.purpose === 'archive' &&
        b.protected &&
        b.size > 0,
    );
    for (const candidate of existingCandidates) {
      const headSize = await this.objectStore.headObject(candidate.key).catch(() => 0);
      if (headSize > 0) {
        const inspectRes = await this.verificationService
          .inspectAndVerifyBackup(candidate.key)
          .catch(() => null);
        if (inspectRes?.valid) {
          return true;
        }
      }
    }
    return false;
  }

  async isNeonOfficialQuotaExceeded(): Promise<{
    exceeded: boolean;
    degraded: boolean;
    reason?: string;
  }> {
    if (!this.neonTrafficService) {
      return { exceeded: false, degraded: true, reason: 'neon_service_missing' };
    }
    try {
      const traffic = await this.neonTrafficService.fetchMonthlyTraffic(false);
      if (traffic.status !== 'active') {
        return { exceeded: false, degraded: true, reason: traffic.status };
      }
      if (traffic.stale) {
        return { exceeded: false, degraded: true, reason: 'stale' };
      }
      if (!this.neonTrafficService.isCurrentBillingPeriod(traffic)) {
        return { exceeded: false, degraded: true, reason: 'billing_period_mismatch' };
      }
      if (traffic.dataTransferBytes === null) {
        return { exceeded: false, degraded: true, reason: 'data_transfer_bytes_null' };
      }
      const exceeded = traffic.dataTransferBytes >= 4.0 * 1024 * 1024 * 1024;
      return {
        exceeded,
        degraded: false,
        reason: exceeded ? 'traffic_quota_exceeded' : undefined,
      };
    } catch {
      return { exceeded: false, degraded: true, reason: 'neon_fetch_error' };
    }
  }

  private async recordAuditLog(username: string, action: string, details: string) {
    try {
      await this.prisma.auditLog.create({
        data: {
          username,
          action,
          details,
        },
      });
    } catch (err: any) {
      this.logger.warn(`写入审计日志失败 [${action}]: ${err.message}`);
    }
  }

  async executeArchiveSeasonBackupWithLock(
    username: string,
    seasonId: string,
    trigger: 'archive' | 'backfill' | 'retry',
    signal?: AbortSignal,
  ): Promise<{
    seasonId: string;
    status: 'succeeded' | 'skipped' | 'failed';
    reason?: string;
    backupKey?: string;
    error?: string;
  }> {
    // 退避期安全检查：若上一次失败且仍在 nextAttemptAt 冷却期内，跳过本次执行
    const latestRunCheck = await this.prisma.backupRun.findFirst({
      where: { selectorKey: `season:${seasonId}`, purpose: 'archive' },
      orderBy: { createdAt: 'desc' },
    });
    if (
      latestRunCheck?.status === 'failed' &&
      latestRunCheck.nextAttemptAt &&
      latestRunCheck.nextAttemptAt > new Date()
    ) {
      return {
        seasonId,
        status: 'skipped',
        reason: 'backing_off',
      };
    }

    const lockKey = `season:${seasonId}:archive`;
    const instanceId = randomUUID();
    const lockRes = await this.acquireLock(lockKey, instanceId);

    if (!lockRes.acquired) {
      return {
        seasonId,
        status: 'skipped',
        reason: 'duplicate_in_flight',
      };
    }

    const leaseToken = lockRes.leaseToken!;
    const taskKey = `archive:season:${seasonId}`;
    const selectorKey = `season:${seasonId}`;

    const existingRun = await this.prisma.backupRun.findUnique({ where: { taskKey } });
    const currentAttempts = (existingRun?.attempts || 0) + 1;

    await this.prisma.backupRun.upsert({
      where: { taskKey },
      create: {
        taskKey,
        trigger,
        scope: 'module',
        module: 'season',
        selectorKey,
        purpose: 'archive',
        status: 'running',
        leaseToken,
        attempts: currentAttempts,
        startedAt: new Date(),
      },
      update: {
        trigger,
        status: 'running',
        leaseToken,
        attempts: currentAttempts,
        startedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });

    const internalAbort = new AbortController();
    const onExternalAbort = () => internalAbort.abort();
    if (signal) {
      if (signal.aborted) internalAbort.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // 周期性续租心跳 (每 20 秒续约一次，防单赛季长时间导出被提前接管；严禁为已过期租约续命)
    let isHeartbeatInFlight = false;
    const heartbeatTimer = setInterval(async () => {
      if (isHeartbeatInFlight) return;
      isHeartbeatInFlight = true;
      try {
        const now = new Date();
        const renew = await this.prisma.backupLock.updateMany({
          where: {
            lockKey,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
        });
        if (renew.count === 0) {
          internalAbort.abort();
          clearInterval(heartbeatTimer);
        }
      } catch {
        // 忽略单次网络闪断
      } finally {
        isHeartbeatInFlight = false;
      }
    }, 20000);

    let createdBackupKey: string | null = null;
    let committedSuccess = false;

    try {
      const allBackups = await this.objectStore.listBackups();
      const existingCandidates = allBackups
        .filter(
          (b) =>
            b.scope === 'module' &&
            b.module === 'season' &&
            b.seasonId === seasonId &&
            b.purpose === 'archive' &&
            b.protected &&
            b.size > 0,
        )
        .sort((a, b) => {
          const tA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const tB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          return tB - tA;
        });

      for (const existing of existingCandidates) {
        const isHeadOk = (await this.objectStore.headObject(existing.key).catch(() => 0)) > 0;
        if (isHeadOk) {
          const inspectRes = await this.verificationService.inspectAndVerifyBackup(existing.key);
          if (inspectRes.valid) {
            // 孤儿认领必须在事务中原子 CAS 续锁核验 + 条件更新 BackupRun (fencing guard)
            await this.prisma.$transaction(async (tx) => {
              const now = new Date();
              const lockCas = await tx.backupLock.updateMany({
                where: {
                  lockKey,
                  leaseToken,
                  leaseExpiresAt: { gt: now },
                },
                data: {
                  leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
                },
              });
              if (lockCas.count === 0) {
                throw new Error('孤儿认领前租约已失效或被接管 (fencing check failed)');
              }
              const updateRes = await tx.backupRun.updateMany({
                where: { taskKey, leaseToken },
                data: {
                  status: 'succeeded',
                  backupKey: existing.key,
                  checksum: inspectRes.checksum || existing.checksum || null,
                  objectSize: BigInt(existing.size),
                  verifiedAt: new Date(),
                  finishedAt: new Date(),
                },
              });
              if (updateRes.count === 0) {
                throw new Error('BackupRun 租约已不匹配，拒绝孤儿认领');
              }
            });

            committedSuccess = true;
            await this.releaseLock(lockKey, leaseToken);
            return {
              seasonId,
              status: 'skipped',
              reason: 'already_protected',
              backupKey: existing.key,
            };
          }
        }
      }

      const quotaCheck = await this.isNeonOfficialQuotaExceeded();
      if (quotaCheck.exceeded) {
        const hasProtected = await this.hasValidProtectedBackupForSeason(seasonId);
        if (hasProtected) {
          await this.recordAuditLog(
            username,
            'AUDIT_TRAFFIC_QUOTA_EXCEEDED',
            `Neon 官方流量已达 4GB 红色阈值，暂停赛季 ${seasonId} 的非必要归档重备份`,
          );
          await this.prisma.backupRun.updateMany({
            where: { taskKey, leaseToken },
            data: {
              status: 'skipped',
              skipReason: 'traffic_quota_exceeded',
              finishedAt: new Date(),
            },
          });
          await this.releaseLock(lockKey, leaseToken).catch(() => {});
          return {
            seasonId,
            status: 'skipped',
            reason: 'traffic_quota_exceeded',
          };
        } else {
          await this.recordAuditLog(
            username,
            'EMERGENCY_ARCHIVE_BACKFILL_UNDER_QUOTA',
            `Neon 官方流量已达 4GB 红色阈值，但赛季 ${seasonId} 缺失受保护备份，执行紧急必要补缺`,
          );
        }
      }

      const backupMetadata = await this.exportService.createBackup(username, {
        scope: 'module',
        module: 'season',
        selector: { seasonId },
        purpose: 'archive',
        protected: true,
        signal: internalAbort.signal,
      });

      createdBackupKey = backupMetadata.key;

      // 最终成功提交：通过原子 CAS 续锁核验所有权与 BackupRun 更新在同一事务内原子执行
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const lockCas = await tx.backupLock.updateMany({
          where: {
            lockKey,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
          },
        });
        if (lockCas.count === 0) {
          throw new Error('租约在备份导出期间过期或已被其他实例接管 (fencing check failed)');
        }

        const updateRes = await tx.backupRun.updateMany({
          where: { taskKey, leaseToken },
          data: {
            status: 'succeeded',
            backupKey: backupMetadata.key,
            checksum: backupMetadata.checksum,
            objectSize: BigInt(backupMetadata.size),
            verifiedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        if (updateRes.count === 0) {
          throw new Error('BackupRun 租约所有权已丢失，拒绝提交成功状态');
        }
      });

      committedSuccess = true;
      await this.releaseLock(lockKey, leaseToken);
      return {
        seasonId,
        status: 'succeeded',
        backupKey: backupMetadata.key,
      };
    } catch (err: any) {
      if (createdBackupKey && !committedSuccess) {
        await this.objectStore.deleteObject(createdBackupKey).catch(() => {});
      }
      await this.releaseLock(lockKey, leaseToken).catch(() => {});

      // 仅当 BackupRun 仍归属于本次 leaseToken 时才允许标记为 failed，防止旧实例覆盖新实例状态
      const backoffMinutes = Math.min(Math.pow(2, currentAttempts), 60);
      const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

      await this.prisma.backupRun
        .updateMany({
          where: { taskKey, leaseToken },
          data: {
            status: 'failed',
            failureCode: 'ARCHIVE_BACKUP_FAILED',
            failureMessage: (err.message || String(err)).slice(0, 1000),
            nextAttemptAt,
            finishedAt: new Date(),
          },
        })
        .catch(() => {});

      return {
        seasonId,
        status: 'failed',
        error: err.message || '归档保护备份执行异常',
      };
    } finally {
      clearInterval(heartbeatTimer);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async createArchiveSeasonBackup(username: string, seasonId: string) {
    const res = await this.executeArchiveSeasonBackupWithLock(username, seasonId, 'archive');
    if (res.status === 'failed') {
      throw new Error(res.error || '归档备份创建失败');
    }
    return res;
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

  async listBackups(options?: { includeUploads?: boolean }): Promise<BackupMetadata[]> {
    const backups = await this.objectStore.listBackups(options);
    if (!backups || backups.length === 0) return [];

    const keys = backups.map((b) => b.key);
    const runs = await this.prisma.backupRun.findMany({
      where: {
        backupKey: { in: keys },
        status: 'succeeded',
      },
      orderBy: { createdAt: 'desc' },
    });

    const runMap = new Map<string, (typeof runs)[0]>();
    for (const run of runs) {
      if (run.backupKey && !runMap.has(run.backupKey)) {
        runMap.set(run.backupKey, run);
      }
    }

    return backups.map((b) => {
      const run = runMap.get(b.key);
      const runMetrics: BackupRunMetrics | null = run
        ? {
            databaseBytesEstimated:
              run.databaseBytesEstimated !== null && run.databaseBytesEstimated !== undefined
                ? String(run.databaseBytesEstimated)
                : null,
            uncompressedBytes:
              run.uncompressedBytes !== null && run.uncompressedBytes !== undefined
                ? String(run.uncompressedBytes)
                : null,
            uploadedBytes:
              run.uploadedBytes !== null && run.uploadedBytes !== undefined
                ? String(run.uploadedBytes)
                : null,
            databaseRowsRead:
              run.databaseRowsRead !== null && run.databaseRowsRead !== undefined
                ? run.databaseRowsRead
                : null,
            peakRssBytes:
              run.peakRssBytes !== null && run.peakRssBytes !== undefined
                ? String(run.peakRssBytes)
                : null,
          }
        : null;

      return {
        ...b,
        runMetrics,
      };
    });
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

  async listBackupRuns(query: BackupRunListQueryDto) {
    const where: any = {};
    if (query.module) where.module = query.module;
    if (query.status) where.status = query.status;
    if (query.trigger) where.trigger = query.trigger;
    if (query.batchId) where.batchId = query.batchId;
    if (query.selectorKey) where.selectorKey = query.selectorKey;
    if (query.backupKey) where.backupKey = query.backupKey;

    const limit = query.limit !== undefined ? Number(query.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit 必须为 1 到 100 之间的整数');
    }

    const offset = query.offset !== undefined ? Number(query.offset) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('offset 必须为大于或等于 0 的整数');
    }

    const [total, items] = await Promise.all([
      this.prisma.backupRun.count({ where }),
      this.prisma.backupRun.findMany({
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
      items: items.map((run) => ({
        ...run,
        objectSize:
          run.objectSize !== null && run.objectSize !== undefined ? String(run.objectSize) : null,
        databaseBytesEstimated:
          run.databaseBytesEstimated !== null && run.databaseBytesEstimated !== undefined
            ? String(run.databaseBytesEstimated)
            : null,
        uncompressedBytes:
          run.uncompressedBytes !== null && run.uncompressedBytes !== undefined
            ? String(run.uncompressedBytes)
            : null,
        uploadedBytes:
          run.uploadedBytes !== null && run.uploadedBytes !== undefined
            ? String(run.uploadedBytes)
            : null,
        peakRssBytes:
          run.peakRssBytes !== null && run.peakRssBytes !== undefined
            ? String(run.peakRssBytes)
            : null,
      })),
    };
  }

  async listBackupCheckpoints(query?: { module?: string; selectorKey?: string }) {
    const where: any = {};
    if (query?.module) where.module = query.module;
    if (query?.selectorKey) where.selectorKey = query.selectorKey;

    return this.prisma.backupModuleCheckpoint.findMany({
      where,
      orderBy: [{ module: 'asc' }, { selectorKey: 'asc' }],
    });
  }

  async getDashboard() {
    const now = new Date();
    const utcYear = now.getUTCFullYear();
    const utcMonth = now.getUTCMonth();
    const startOfMonth = new Date(Date.UTC(utcYear, utcMonth, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(utcYear, utcMonth + 1, 1, 0, 0, 0, 0));
    const periodKey = `${utcYear}-${String(utcMonth + 1).padStart(2, '0')}`;

    const currentMonthRuns = await this.prisma.backupRun.findMany({
      where: {
        createdAt: {
          gte: startOfMonth,
          lt: endOfMonth,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 1. 应用出口预算统计 (聚合所有产生 databaseBytesEstimated 的运行，包含失败与重试)
    let appUsedBytesBigInt = 0n;
    for (const r of currentMonthRuns) {
      if (r.databaseBytesEstimated !== null && r.databaseBytesEstimated !== undefined) {
        appUsedBytesBigInt += BigInt(r.databaseBytesEstimated);
      }
    }
    const appLimitBytes = 2 * 1024 * 1024 * 1024; // 2 GB
    const appWarningBytes = 1.4 * 1024 * 1024 * 1024; // 1.4 GB (70%)
    const appCriticalBytes = 1.6 * 1024 * 1024 * 1024; // 1.6 GB (80%)
    const appUsedNumber = Number(appUsedBytesBigInt);

    let appAlertLevel: 'normal' | 'warning' | 'critical' = 'normal';
    if (appUsedNumber >= appCriticalBytes) {
      appAlertLevel = 'critical';
    } else if (appUsedNumber >= appWarningBytes) {
      appAlertLevel = 'warning';
    }
    const appPercent = Math.min(100, Math.round((appUsedNumber / appLimitBytes) * 1000) / 10);

    // 2. Neon 官方配额监控
    let neonData = {
      status: 'not_configured' as 'configured' | 'not_configured' | 'unavailable',
      dataTransferBytes: null as number | null,
      capturedAt: null as string | null,
      billingPeriod: null as string | null,
      stale: false,
    };
    if (this.neonTrafficService) {
      try {
        const fetched = await this.neonTrafficService.fetchMonthlyTraffic();
        neonData = {
          status: fetched.status === 'active' ? 'configured' : fetched.status,
          dataTransferBytes: fetched.dataTransferBytes,
          capturedAt: fetched.capturedAt,
          billingPeriod: fetched.billingPeriod,
          stale: fetched.stale,
        };
      } catch {
        neonData = {
          status: 'unavailable',
          dataTransferBytes: null,
          capturedAt: null,
          billingPeriod: null,
          stale: true,
        };
      }
    }
    const neonLimitBytes = 5 * 1024 * 1024 * 1024; // 5 GB
    const neonWarningBytes = 3.5 * 1024 * 1024 * 1024; // 3.5 GB (70%)
    const neonCriticalBytes = 4.0 * 1024 * 1024 * 1024; // 4.0 GB (80%)
    let neonAlertLevel: 'normal' | 'warning' | 'critical' | 'unknown' = 'unknown';
    if (neonData.status === 'configured' && neonData.dataTransferBytes !== null) {
      if (neonData.dataTransferBytes >= neonCriticalBytes) {
        neonAlertLevel = 'critical';
      } else if (neonData.dataTransferBytes >= neonWarningBytes) {
        neonAlertLevel = 'warning';
      } else {
        neonAlertLevel = 'normal';
      }
    }

    // 3. 上传存储量 (仅累加成功备份)
    let storageUsedBigInt = 0n;
    for (const r of currentMonthRuns) {
      if (r.status === 'succeeded' && r.uploadedBytes !== null && r.uploadedBytes !== undefined) {
        storageUsedBigInt += BigInt(r.uploadedBytes);
      }
    }

    // 4. 模块健康度矩阵
    const moduleHealth = await Promise.all(
      REQUIRED_MODULES.map(async (mod) => {
        const [latestRun, latestSuccessRun, checkpoint] = await Promise.all([
          this.prisma.backupRun.findFirst({
            where: { module: mod },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.backupRun.findFirst({
            where: { module: mod, status: 'succeeded' },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.backupModuleCheckpoint.findFirst({
            where: { module: mod },
            orderBy: { updatedAt: 'desc' },
          }),
        ]);

        return {
          module: mod as BackupModule,
          lastRunStatus: latestRun?.status || null,
          lastRunAt: latestRun?.createdAt ? latestRun.createdAt.toISOString() : null,
          lastSuccessfulBackupKey:
            latestSuccessRun?.backupKey || checkpoint?.lastSuccessfulBackupKey || null,
          lastSuccessfulAt: latestSuccessRun?.finishedAt
            ? latestSuccessRun.finishedAt.toISOString()
            : checkpoint?.lastSuccessfulAt
              ? checkpoint.lastSuccessfulAt.toISOString()
              : null,
          fingerprint:
            checkpoint?.fingerprint ||
            latestRun?.fingerprintAfter ||
            latestRun?.fingerprintBefore ||
            null,
        };
      }),
    );

    // 5. 下次计划执行时间 (下个月 1 日 18:00 UTC)
    const candidateThisMonth = new Date(Date.UTC(utcYear, utcMonth, 1, 18, 0, 0, 0));
    const nextScheduledDate =
      now.getTime() < candidateThisMonth.getTime()
        ? candidateThisMonth
        : new Date(Date.UTC(utcYear, utcMonth + 1, 1, 18, 0, 0, 0));

    // 6. 当月任务统计
    const totalRuns = currentMonthRuns.length;
    const succeededRuns = currentMonthRuns.filter((r) => r.status === 'succeeded').length;
    const failedRuns = currentMonthRuns.filter((r) => r.status === 'failed').length;
    const skippedRuns = currentMonthRuns.filter((r) => r.status === 'skipped').length;
    const recentFailedRuns = currentMonthRuns
      .filter((r) => r.status === 'failed')
      .slice(0, 5)
      .map((r) => ({
        id: r.id,
        module: r.module,
        selectorKey: r.selectorKey,
        trigger: r.trigger,
        failureCode: r.failureCode,
        failureMessage: r.failureMessage,
        createdAt: r.createdAt.toISOString(),
      }));

    return {
      applicationBudget: {
        usedBytes: String(appUsedBytesBigInt),
        limitBytes: String(appLimitBytes),
        warningBytes: String(Math.floor(appWarningBytes)),
        criticalBytes: String(Math.floor(appCriticalBytes)),
        alertLevel: appAlertLevel,
        percent: appPercent,
      },
      neonOfficial: {
        status: neonData.status,
        dataTransferBytes:
          neonData.dataTransferBytes !== null ? String(neonData.dataTransferBytes) : null,
        limitBytes: String(neonLimitBytes),
        warningBytes: String(Math.floor(neonWarningBytes)),
        criticalBytes: String(Math.floor(neonCriticalBytes)),
        alertLevel: neonAlertLevel,
        billingPeriod: neonData.billingPeriod,
        capturedAt: neonData.capturedAt,
        stale: neonData.stale,
      },
      storageUploaded: {
        usedBytes: String(storageUsedBigInt),
      },
      moduleHealth,
      nextScheduledAt: nextScheduledDate.toISOString(),
      currentMonthStats: {
        periodKey,
        totalRuns,
        succeededRuns,
        failedRuns,
        skippedRuns,
        hasFailedRuns: failedRuns > 0,
        recentFailedRuns,
      },
    };
  }

  async getMetricsSummary(periodKeyParam?: string) {
    const now = new Date();
    let year: number;
    let month: number; // 0-indexed
    let periodKey: string;

    if (periodKeyParam && /^\d{4}-\d{2}$/.test(periodKeyParam)) {
      const [y, m] = periodKeyParam.split('-');
      year = parseInt(y, 10);
      month = parseInt(m, 10) - 1;
      periodKey = periodKeyParam;
    } else {
      year = now.getUTCFullYear();
      month = now.getUTCMonth();
      periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;
    }

    const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));

    const [monthRuns, incompleteBatchCount] = await Promise.all([
      this.prisma.backupRun.findMany({
        where: {
          createdAt: {
            gte: startOfMonth,
            lt: endOfMonth,
          },
        },
      }),
      this.prisma.backupBatch.count({
        where: {
          periodKey,
          status: 'incomplete',
        },
      }),
    ]);

    let curDatabaseBytes = 0n;
    let curUncompressedBytes = 0n;
    let curUploadedBytes = 0n;
    let targetModularRunsCount = 0;

    for (const r of monthRuns) {
      // 节省率当前值限定为目标模块运行，排除全量备份（基线本身）和 pre-restore 恢复前快照
      if (r.scope !== 'module' || r.purpose === 'pre-restore') {
        continue;
      }
      targetModularRunsCount++;

      // 出口维度：累计成功和失败模块运行的真实读取估算
      if (r.databaseBytesEstimated !== null && r.databaseBytesEstimated !== undefined) {
        curDatabaseBytes += BigInt(r.databaseBytesEstimated);
      }
      if (r.uncompressedBytes !== null && r.uncompressedBytes !== undefined) {
        curUncompressedBytes += BigInt(r.uncompressedBytes);
      }
      // 存储维度：只累计成功的模块上传
      if (r.status === 'succeeded' && r.uploadedBytes !== null && r.uploadedBytes !== undefined) {
        curUploadedBytes += BigInt(r.uploadedBytes);
      }
    }

    // 寻找全量基线：优先当月手动全量备份，次选历史最新全量备份
    let baselineRun = await this.prisma.backupRun.findFirst({
      where: {
        scope: 'full',
        status: 'succeeded',
        purpose: 'manual',
        trigger: 'manual',
        createdAt: { gte: startOfMonth, lt: endOfMonth },
      },
      orderBy: { createdAt: 'desc' },
    });
    let baselineSource: 'monthly_manual_full' | 'historical_full' | 'none' = 'monthly_manual_full';

    if (!baselineRun) {
      baselineRun = await this.prisma.backupRun.findFirst({
        where: {
          scope: 'full',
          status: 'succeeded',
          purpose: { not: 'pre-restore' },
          createdAt: { lt: startOfMonth },
        },
        orderBy: { createdAt: 'desc' },
      });
      baselineSource = baselineRun ? 'historical_full' : 'none';
    }

    // 1. 出口流量同口径比对 (仅当基线 databaseBytesEstimated 存在且 > 0 时有效)
    let databaseExportComparison: {
      baselineAvailable: boolean;
      baselineBytes: string | null;
      currentBytes: string;
      savedBytes: string | null;
      percentSaved: number | null;
      baselineSource: 'monthly_manual_full' | 'historical_full' | 'none';
      baselineBackupKey: string | null;
    };

    if (
      baselineRun &&
      baselineRun.databaseBytesEstimated !== null &&
      baselineRun.databaseBytesEstimated !== undefined &&
      BigInt(baselineRun.databaseBytesEstimated) > 0n
    ) {
      const baseExport = BigInt(baselineRun.databaseBytesEstimated);
      const diffExport = baseExport - curDatabaseBytes;
      const pct = Math.round((Number(diffExport) / Number(baseExport)) * 1000) / 10;
      databaseExportComparison = {
        baselineAvailable: true,
        baselineBytes: String(baseExport),
        currentBytes: String(curDatabaseBytes),
        savedBytes: String(diffExport),
        percentSaved: pct,
        baselineSource,
        baselineBackupKey: baselineRun.backupKey,
      };
    } else {
      databaseExportComparison = {
        baselineAvailable: false,
        baselineBytes: null,
        currentBytes: String(curDatabaseBytes),
        savedBytes: null,
        percentSaved: null,
        baselineSource: 'none',
        baselineBackupKey: null,
      };
    }

    // 2. 存储上传同口径比对 (基线优先 uploadedBytes，兜底 objectSize)
    let storageUploadComparison: {
      baselineAvailable: boolean;
      baselineBytes: string | null;
      currentBytes: string;
      savedBytes: string | null;
      percentSaved: number | null;
      baselineSource: 'monthly_manual_full' | 'historical_full' | 'none';
      baselineBackupKey: string | null;
    };

    if (baselineRun) {
      const baseUpload =
        baselineRun.uploadedBytes !== null && baselineRun.uploadedBytes !== undefined
          ? BigInt(baselineRun.uploadedBytes)
          : baselineRun.objectSize !== null && baselineRun.objectSize !== undefined
            ? BigInt(baselineRun.objectSize)
            : null;

      if (baseUpload !== null && baseUpload > 0n) {
        const diffUpload = baseUpload - curUploadedBytes;
        const pct = Math.round((Number(diffUpload) / Number(baseUpload)) * 1000) / 10;
        storageUploadComparison = {
          baselineAvailable: true,
          baselineBytes: String(baseUpload),
          currentBytes: String(curUploadedBytes),
          savedBytes: String(diffUpload),
          percentSaved: pct,
          baselineSource,
          baselineBackupKey: baselineRun.backupKey,
        };
      } else {
        storageUploadComparison = {
          baselineAvailable: false,
          baselineBytes: null,
          currentBytes: String(curUploadedBytes),
          savedBytes: null,
          percentSaved: null,
          baselineSource: 'none',
          baselineBackupKey: null,
        };
      }
    } else {
      storageUploadComparison = {
        baselineAvailable: false,
        baselineBytes: null,
        currentBytes: String(curUploadedBytes),
        savedBytes: null,
        percentSaved: null,
        baselineSource: 'none',
        baselineBackupKey: null,
      };
    }

    return {
      periodKey,
      databaseExport: databaseExportComparison,
      storageUpload: storageUploadComparison,
      totals: {
        databaseBytesEstimated: String(curDatabaseBytes),
        uncompressedBytes: String(curUncompressedBytes),
        uploadedBytes: String(curUploadedBytes),
        runsCount: targetModularRunsCount,
      },
      hasIncompleteBatches: incompleteBatchCount > 0,
    };
  }

  async getMetricsTimeseries(monthsCount = 6) {
    const validCount = Math.max(1, Math.min(24, monthsCount));
    const now = new Date();
    const results: Array<{
      periodKey: string;
      databaseBytesEstimated: string;
      uncompressedBytes: string;
      uploadedBytes: string;
      totalRuns: number;
      succeededRuns: number;
      failedRuns: number;
    }> = [];

    for (let i = validCount - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1, 0, 0, 0, 0));
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const periodKey = `${y}-${String(m + 1).padStart(2, '0')}`;
      const start = d;
      const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));

      const runs = await this.prisma.backupRun.findMany({
        where: {
          createdAt: {
            gte: start,
            lt: end,
          },
        },
      });

      let databaseBytes = 0n;
      let uncompressedBytes = 0n;
      let uploadedBytes = 0n;
      let succeededCount = 0;
      let failedCount = 0;

      for (const r of runs) {
        if (r.databaseBytesEstimated !== null && r.databaseBytesEstimated !== undefined) {
          databaseBytes += BigInt(r.databaseBytesEstimated);
        }
        if (r.uncompressedBytes !== null && r.uncompressedBytes !== undefined) {
          uncompressedBytes += BigInt(r.uncompressedBytes);
        }
        if (r.status === 'succeeded') {
          succeededCount++;
          if (r.uploadedBytes !== null && r.uploadedBytes !== undefined) {
            uploadedBytes += BigInt(r.uploadedBytes);
          }
        } else if (r.status === 'failed') {
          failedCount++;
        }
      }

      results.push({
        periodKey,
        databaseBytesEstimated: String(databaseBytes),
        uncompressedBytes: String(uncompressedBytes),
        uploadedBytes: String(uploadedBytes),
        totalRuns: runs.length,
        succeededRuns: succeededCount,
        failedRuns: failedCount,
      });
    }

    return results;
  }

  async retryBackupRun(
    runId: string,
    operatorUsername: string,
  ): Promise<ScheduledModuleTaskResult> {
    const lockKey = `lock:backup:retry:${runId}`;
    const instanceId = randomUUID();
    const lockRes = await this.acquireBackupLock('module', lockKey, instanceId);
    if (!lockRes.acquired) {
      throw new ConflictException('当前任务重试正在执行中 (retry_in_flight)');
    }
    const retryLeaseToken = lockRes.leaseToken;

    try {
      const originalRun = await this.prisma.backupRun.findUnique({
        where: { id: runId },
      });
      if (!originalRun) {
        throw new NotFoundException(`未找到备份运行记录: ${runId}`);
      }
      if (originalRun.status !== 'failed') {
        throw new BadRequestException('仅支持重试失败状态 (failed) 的任务记录');
      }
      if (originalRun.scope !== 'module') {
        throw new BadRequestException('目前仅支持模块备份任务重试');
      }
      if (!BACKUP_MODULES.includes(originalRun.module as BackupModule)) {
        throw new BadRequestException(`非法的模块名称: ${originalRun.module}`);
      }

      // 白名单校验：仅支持 manual, scheduled, archive
      if (!['manual', 'scheduled', 'archive'].includes(originalRun.purpose)) {
        throw new BadRequestException(`不支持 ${originalRun.purpose} 类型的任务重试`);
      }

      let selector: Record<string, string> = {};
      if (originalRun.module === 'season' && originalRun.selectorKey.startsWith('season:')) {
        const seasonId = originalRun.selectorKey.slice('season:'.length);
        selector = { seasonId };
      }

      const nextAttempts = (originalRun.attempts || 1) + 1;

      const result = await this.orchestrateModuleBackup({
        username: operatorUsername,
        module: originalRun.module as BackupModule,
        selector,
        purpose: originalRun.purpose as any,
        trigger: 'retry',
        batchId: originalRun.batchId || undefined,
        attempts: nextAttempts,
        retryOfRunId: originalRun.id,
      });

      if (originalRun.batchId) {
        await this.recomputeBatchStatus(originalRun.batchId).catch((err) => {
          this.logger.warn(`批次 ${originalRun.batchId} 状态重算失败: ${err.message}`);
        });
      }

      return result;
    } finally {
      await this.releaseLock(lockKey, retryLeaseToken).catch(() => {});
    }
  }

  async recomputeBatchStatus(batchId: string): Promise<void> {
    const runs = await this.prisma.backupRun.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
    });
    if (!runs || runs.length === 0) return;

    // 按 module + selectorKey + purpose 分组，取最新 attempt
    const latestRunsByTarget = new Map<string, (typeof runs)[0]>();
    for (const run of runs) {
      const groupKey = `${run.module}:${run.selectorKey}:${run.purpose}`;
      latestRunsByTarget.set(groupKey, run);
    }

    let hasRunning = false;
    let succeededCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const items: ScheduledModuleTaskResult[] = [];

    for (const run of latestRunsByTarget.values()) {
      if (run.status === 'running' || run.status === 'pending') {
        hasRunning = true;
      } else if (run.status === 'succeeded') {
        succeededCount++;
        items.push({
          status: 'created',
          module: run.module as BackupModule,
          selector:
            run.module === 'season' && run.selectorKey.startsWith('season:')
              ? { seasonId: run.selectorKey.slice('season:'.length) }
              : {},
          backup: {
            key: run.backupKey || '',
            filename: run.backupKey ? run.backupKey.split('/').pop() || '' : '',
            size: run.objectSize ? Number(run.objectSize) : 0,
            checksum: run.checksum || undefined,
            module: run.module as BackupModule,
          },
          durationMs: run.durationMs || 0,
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : new Date().toISOString(),
        });
      } else if (run.status === 'skipped') {
        skippedCount++;
        items.push({
          status: 'skipped',
          module: run.module as BackupModule,
          selector:
            run.module === 'season' && run.selectorKey.startsWith('season:')
              ? { seasonId: run.selectorKey.slice('season:'.length) }
              : {},
          reason: (run.skipReason as any) || 'unchanged',
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : new Date().toISOString(),
        });
      } else {
        failedCount++;
        items.push({
          status: 'failed',
          module: run.module as BackupModule,
          selector:
            run.module === 'season' && run.selectorKey.startsWith('season:')
              ? { seasonId: run.selectorKey.slice('season:'.length) }
              : {},
          reason: (run.failureCode as any) || 'export_error',
          error: run.failureMessage || '任务执行失败',
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : new Date().toISOString(),
        });
      }
    }

    let batchStatus: 'running' | 'succeeded' | 'incomplete' | 'failed';
    if (hasRunning) {
      batchStatus = 'running';
    } else if (failedCount === 0) {
      batchStatus = 'succeeded';
    } else if (succeededCount === 0 && skippedCount === 0) {
      batchStatus = 'failed';
    } else {
      // 部分成功/跳过，同时存在失败
      batchStatus = 'incomplete';
    }

    await this.prisma.backupBatch.update({
      where: { id: batchId },
      data: {
        status: batchStatus,
        items: items as any,
        finishedAt: batchStatus === 'running' ? null : new Date(),
      },
    });
  }
}
