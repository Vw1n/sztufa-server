import { Module } from '@nestjs/common';
import { SeasonService } from './season.service';
import { SeasonLifecycleService } from './season-lifecycle.service';
import { SeasonGroupService } from './season-group.service';
import { KnockoutGeneratorService } from './knockout-generator.service';
import { SeasonDeletionService } from './season-deletion.service';
import { SeasonController } from './season.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  providers: [
    SeasonService,
    SeasonLifecycleService,
    SeasonGroupService,
    KnockoutGeneratorService,
    SeasonDeletionService,
  ],
  controllers: [SeasonController],
  exports: [SeasonService],
})
export class SeasonModule {}
