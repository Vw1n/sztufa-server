import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { SeasonService } from './season.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/seasons')
export class SeasonController {
  constructor(private readonly seasonService: SeasonService) {}

  @Get()
  async getSeasons() {
    return this.seasonService.getSeasons();
  }

  @Get('active')
  async getActiveSeason() {
    return this.seasonService.getActiveSeason();
  }

  @Get(':id/standings')
  async getSeasonStandings(@Param('id') id: string) {
    return this.seasonService.getSeasonStandings(id);
  }

  @Get(':id/stats')
  async getSeasonStats(@Param('id') id: string) {
    return this.seasonService.getSeasonStats(id);
  }

  @Get(':id/groups')
  async getSeasonGroups(@Param('id') id: string) {
    return this.seasonService.getSeasonGroups(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post(':id/groups')
  async updateSeasonGroups(
    @Param('id') id: string,
    @Body('groups') groups: { teamId: string; groupName: string }[],
    @Request() req: any,
  ) {
    const username = req.user?.username || 'admin';
    return this.seasonService.updateSeasonGroups(id, groups, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post(':id/generate-knockout')
  async generateKnockoutMatches(@Param('id') id: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.seasonService.generateKnockoutMatches(id, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post()
  async createSeason(@Body('name') name: string, @Body('type') type: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.seasonService.createSeason(name, type, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Patch(':id/status')
  async updateSeasonStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @Request() req: any,
  ) {
    const username = req.user?.username || 'admin';
    return this.seasonService.updateSeasonStatus(id, status, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Patch(':id')
  async renameSeason(@Param('id') id: string, @Body('name') name: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.seasonService.renameSeason(id, name, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Delete(':id')
  async deleteSeason(@Param('id') id: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.seasonService.deleteSeason(id, username);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('archive')
  async archiveSeason(@Body('name') name: string, @Body('type') type: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.seasonService.archiveAndCreateNewSeason(name, type, username);
  }
}
