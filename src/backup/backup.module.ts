import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupRetentionService } from './backup-retention.service';

@Module({
  providers: [BackupService, BackupRetentionService],
  controllers: [BackupController],
})
export class BackupModule {}
