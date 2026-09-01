import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';

@Injectable()
export class SeasonGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async getSeasonStandings(id: string, refresh = false) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { standingsCache: true },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    if (!season.standingsCache || refresh) {
      await this.seasonStatistics.computeAndCache(id);
      const updated = await this.prisma.season.findUnique({
        where: { id },
        select: { standingsCache: true },
      });
      return updated?.standingsCache || [];
    }
    return season.standingsCache || [];
  }

  async getSeasonStats(id: string, refresh = false) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { statsCache: true },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    if (!season.statsCache || refresh) {
      await this.seasonStatistics.computeAndCache(id);
      const updated = await this.prisma.season.findUnique({
        where: { id },
        select: { statsCache: true },
      });
      return updated?.statsCache || { scorers: [], assists: [], cards: [] };
    }
    return season.statsCache || { scorers: [], assists: [], cards: [] };
  }

  async getSeasonGroups(seasonId: string) {
    return this.prisma.seasonGroupTeam.findMany({
      where: { seasonId },
      include: { team: true },
      orderBy: { groupName: 'asc' },
    });
  }

  async updateSeasonGroups(
    seasonId: string,
    groups: { teamId: string; groupName: string }[],
    username: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.seasonGroupTeam.deleteMany({
        where: { seasonId },
      });

      if (groups && groups.length > 0) {
        await tx.seasonGroupTeam.createMany({
          data: groups.map((g) => ({
            seasonId,
            teamId: g.teamId,
            groupName: g.groupName,
          })),
        });
      }
    });

    const cacheResult = await this.seasonStatistics.computeAndCache(seasonId);
    if (!cacheResult.success) {
      console.error(`[Season Groups] 积分榜缓存更新失败: ${cacheResult.error}`);
    }

    await this.auditLogService.log(
      username,
      'UPDATE_SEASON_GROUPS',
      `更新了赛季 ID 为 ${seasonId} 的小组赛分组配置，共分配 ${groups.length} 支球队。`,
    );

    return { success: true };
  }
}
