import { Module } from '@nestjs/common';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TeamQueryService } from './team-query.service';
import { TeamRosterService } from './team-roster.service';
import { TeamAssetPipelineService } from './team-asset-pipeline.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuditLogModule, UploadModule],
  controllers: [TeamController],
  providers: [TeamService, TeamQueryService, TeamRosterService, TeamAssetPipelineService],
  exports: [TeamService, TeamQueryService, TeamRosterService, TeamAssetPipelineService],
})
export class TeamModule {}
