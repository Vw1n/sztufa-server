import { Injectable } from '@nestjs/common';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupRetentionService } from './backup-retention.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBackupOptions } from './backup.types';
import { BackupModuleRestoreService } from './backup-module-restore.service';

// 保持既有外部导入兼容性的符号 re-export
export { MANDATORY_BACKUP_TABLES } from './backup-table-registry';
export { validateBackupSchemaAndIntegrity } from './backup-validator';
export type { BackupMetadata, UploadInitResult, CreateBackupOptions } from './backup.types';

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
    options?: Parameters<BackupExportService['createBackup']>[1],
  ) {
    const scheduledOptions = options?.scope
      ? options
      : await this.resolveScheduledBackupOptions(options?.signal);
    const configuredHours = Number(process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS || 144);
    const minIntervalHours = Number.isFinite(configuredHours) ? Math.max(0, configuredHours) : 144;

    if (minIntervalHours > 0) {
      const backups = await this.objectStore.listBackups();
      const cutoff = Date.now() - minIntervalHours * 60 * 60 * 1000;
      const latestScheduled = backups.find(
        (backup) =>
          backup.purpose === 'scheduled' &&
          (backup.scope || 'full') === (scheduledOptions.scope || 'full') &&
          (backup.module || undefined) === (scheduledOptions.module || undefined) &&
          (backup.seasonId || undefined) ===
            (scheduledOptions.selector?.seasonId || scheduledOptions.seasonId || undefined) &&
          !!backup.lastModified,
      );

      if (latestScheduled?.lastModified) {
        const latestBackupTime = new Date(latestScheduled.lastModified).getTime();
        if (latestBackupTime >= cutoff) return latestScheduled;

        if (
          scheduledOptions.scope === 'module' &&
          process.env.SCHEDULED_BACKUP_CHANGE_DETECTION_ENABLED !== 'false'
        ) {
          const latestChange = await this.getLatestBusinessChange(scheduledOptions);
          if (!latestChange || latestChange.getTime() <= latestBackupTime) return latestScheduled;
        }
      }
    }

    return this.exportService.createBackup(username, {
      ...scheduledOptions,
      purpose: 'scheduled',
    });
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
    const day = new Date().getUTCDay();
    if (day === 0) return { scope: 'full', signal };

    const modules = ['season', 'staff', 'members', 'content', 'operations', 'season'] as const;
    const module = modules[day - 1];
    if (module !== 'season') return { scope: 'module', module, selector: {}, signal };

    const activeSeason = await this.prisma.season.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!activeSeason) return { scope: 'full', signal };
    return {
      scope: 'module',
      module: 'season',
      selector: { seasonId: activeSeason.id },
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
