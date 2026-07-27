import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { PredictionController } from './prediction.controller';
import { PredictionService } from './prediction.service';

@Module({
  imports: [PrismaModule, AuditLogModule, AuthModule],
  controllers: [PredictionController],
  providers: [PredictionService],
  exports: [PredictionService],
})
export class PredictionModule {}
