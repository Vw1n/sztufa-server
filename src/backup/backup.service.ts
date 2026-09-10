import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID, createHmac, createHash } from 'crypto';
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
import { BackupModule, BACKUP_MODULE_REGISTRY } from './backup-module-registry';

// 保持既有外部导入兼容性的符号 re-export
export { MANDATORY_BACKUP_TABLES } from './backup-table-registry';
export { validateBackupSchemaAndIntegrity } from './backup-validator';
export type { BackupMetadata, UploadInitResult, CreateBackupOptions } from './backup.types';

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
