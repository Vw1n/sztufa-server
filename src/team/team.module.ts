import { Module } from '@nestjs/common';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TeamQueryService } from './team-query.service';
import { TeamRosterService } from './team-roster.service';

import { SeasonModule } from '../season/season.module';

@Module({
  imports: [AuditLogModule, SeasonModule],
  controllers: [TeamController],
  providers: [TeamService, TeamQueryService, TeamRosterService],
  exports: [TeamService, TeamQueryService, TeamRosterService],
})
export class TeamModule {}
