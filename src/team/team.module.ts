import { Module } from '@nestjs/common';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TeamQueryService } from './team-query.service';
import { TeamRosterService } from './team-roster.service';

@Module({
  imports: [AuditLogModule],
  controllers: [TeamController],
  providers: [TeamService, TeamQueryService, TeamRosterService],
  exports: [TeamService, TeamQueryService, TeamRosterService],
})
export class TeamModule {}
