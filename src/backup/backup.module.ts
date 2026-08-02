import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupRetentionService } from './backup-retention.service';
import { BackupScopeService } from './backup-scope.service';

@Module({
  providers: [BackupService, BackupRetentionService, BackupScopeService],
  controllers: [BackupController],
})
export class BackupModule {}
