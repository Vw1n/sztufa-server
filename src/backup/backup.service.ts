import { Injectable } from '@nestjs/common';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupRetentionService } from './backup-retention.service';

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
  ) {}

  createBackup(username: string, options?: Parameters<BackupExportService['createBackup']>[1]) {
    return this.exportService.createBackup(username, options);
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
