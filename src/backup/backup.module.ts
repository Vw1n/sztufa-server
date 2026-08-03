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

@Module({
  providers: [
    BackupService,
    BackupObjectStoreService,
    BackupVerificationService,
    BackupExportService,
    BackupRestoreService,
    BackupUploadService,
    BackupMaintenanceService,
    BackupRetentionService,
    BackupScopeService,
  ],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
