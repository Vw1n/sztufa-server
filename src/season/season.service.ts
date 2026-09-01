import { Injectable } from '@nestjs/common';
import { SeasonLifecycleService } from './season-lifecycle.service';
import { SeasonGroupService } from './season-group.service';
import { KnockoutGeneratorService } from './knockout-generator.service';
import { SeasonDeletionService } from './season-deletion.service';

@Injectable()
export class SeasonService {
  constructor(
    private readonly lifecycleService: SeasonLifecycleService,
    private readonly groupService: SeasonGroupService,
    private readonly knockoutService: KnockoutGeneratorService,
    private readonly deletionService: SeasonDeletionService,
  ) {}

  async getSeasons() {
    return this.lifecycleService.getSeasons();
  }

  async getActiveSeason() {
    return this.lifecycleService.getActiveSeason();
  }

  async createSeason(name: string, type: string, username: string) {
    return this.lifecycleService.createSeason(name, type, username);
  }

  async archiveAndCreateNewSeason(name: string, type: string, username: string) {
    return this.lifecycleService.archiveAndCreateNewSeason(name, type, username);
  }

  async updateSeasonStatus(id: string, status: string, username: string) {
    return this.lifecycleService.updateSeasonStatus(id, status, username);
  }

  async renameSeason(id: string, name: string, username: string) {
    return this.lifecycleService.renameSeason(id, name, username);
  }

  async getSeasonStandings(id: string) {
    return this.groupService.getSeasonStandings(id);
  }

  async getSeasonStats(id: string) {
    return this.groupService.getSeasonStats(id);
  }

  async getSeasonGroups(seasonId: string) {
    return this.groupService.getSeasonGroups(seasonId);
  }

  async updateSeasonGroups(
    seasonId: string,
    groups: { teamId: string; groupName: string }[],
    username: string,
  ) {
    return this.groupService.updateSeasonGroups(seasonId, groups, username);
  }

  async generateKnockoutMatches(seasonId: string, username: string) {
    return this.knockoutService.generateKnockoutMatches(seasonId, username);
  }

  async approveSeasonDeletion(id: string, approverId: string | undefined, username: string) {
    return this.deletionService.approveSeasonDeletion(id, approverId, username);
  }
}
