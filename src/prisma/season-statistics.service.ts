import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LeagueStandingsCalculator } from './league-standings.calculator';
import { CupStandingsCalculator } from './cup-standings.calculator';
import { PlayerStatisticsCalculator } from './player-statistics.calculator';
import { Prisma } from '@prisma/client';

@Injectable()
export class SeasonStatisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leagueCalculator: LeagueStandingsCalculator,
    private readonly cupCalculator: CupStandingsCalculator,
    private readonly playerStatsCalculator: PlayerStatisticsCalculator,
  ) {}

  async computeAndCache(seasonId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
      if (!season) return { success: false, error: '赛季不存在' };

      const seasonType = season.type || 'LEAGUE';
      const seasonGender =
        season.name.includes('女') || season.name.includes('女子') ? 'FEMALE' : 'MALE';

      const matches = await this.prisma.match.findMany({
        where: { seasonId, deletedAt: null, status: 'finished' },
        include: { goals: true, events: true },
      });

      const seasonPlayers = await this.prisma.seasonTeamPlayer.findMany({
        where: { seasonId },
        include: { team: true },
      });

      const teamsMap = new Map<string, { id: string; teamName: string; teamLogo: string }>();
      seasonPlayers.forEach((seasonPlayer) => {
        if (
          seasonPlayer.team &&
          !teamsMap.has(seasonPlayer.teamId) &&
          seasonPlayer.team.gender === seasonGender
        ) {
          teamsMap.set(seasonPlayer.teamId, {
            id: seasonPlayer.teamId,
            teamName: seasonPlayer.team.teamName,
            teamLogo: seasonPlayer.team.teamLogo || '',
          });
        }
      });

      const allTeams = await this.prisma.team.findMany();
      const databaseTeams = new Map(allTeams.map((team) => [team.id, team]));

      matches.forEach((match) => {
        const addTeamIfValid = (teamId: string) => {
          if (teamsMap.has(teamId)) return;
          const team = databaseTeams.get(teamId);
          if (team && team.gender === seasonGender) {
            teamsMap.set(teamId, {
              id: team.id,
              teamName: team.teamName,
              teamLogo: team.teamLogo || '',
            });
          }
        };
        addTeamIfValid(match.homeTeamId);
        addTeamIfValid(match.awayTeamId);
      });

      // 使用对应的计算器计算积分榜
      const standings =
        seasonType === 'CUP'
          ? await this.cupCalculator.calculate(seasonId, seasonGender, matches, databaseTeams)
          : this.leagueCalculator.calculate(matches, teamsMap);

      // 计算球员统计
      const stats = await this.playerStatsCalculator.calculate(matches, databaseTeams);

      // 更新缓存
      await this.prisma.season.update({
        where: { id: seasonId },
        data: {
          standingsCache: standings as unknown as Prisma.InputJsonValue,
          statsCache: stats as unknown as Prisma.InputJsonValue,
        },
      });
      console.log(
        `[Cache Update] Standings & stats pre-computed successfully for season ${seasonId}`,
      );
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Cache Update] Failed to compute/cache standings for season ${seasonId}:`,
        error,
      );
      return { success: false, error: errorMsg };
    }
  }
}
