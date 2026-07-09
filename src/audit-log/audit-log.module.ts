import { Module, Global } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditLogController } from './audit-log.controller';
import { PrismaService } from '../prisma/prisma.service';

@Global()
@Module({
  providers: [AuditLogService, PrismaService],
  controllers: [AuditLogController],
  exports: [AuditLogService],
})
export class AuditLogModule {}
