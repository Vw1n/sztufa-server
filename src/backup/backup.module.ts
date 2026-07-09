import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [BackupService, PrismaService],
  controllers: [BackupController],
})
export class BackupModule {}
