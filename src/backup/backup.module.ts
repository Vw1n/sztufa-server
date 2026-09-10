import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupRetentionService } from './backup-retention.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupPlanService } from './backup-plan.service';
import { BackupModuleRestoreService } from './backup-module-restore.service';
import { BackupFingerprintService } from './backup-fingerprint.service';

@Module({
  providers: [
    BackupService,
    BackupFingerprintService,
    BackupObjectStoreService,
    BackupVerificationService,
    BackupExportService,
    BackupRestoreService,
    BackupUploadService,
    BackupMaintenanceService,
    BackupRetentionService,
    BackupScopeService,
    BackupPlanService,
    BackupModuleRestoreService,
  ],
  controllers: [BackupController],
  exports: [BackupService, BackupFingerprintService],
})
export class BackupModule {}
