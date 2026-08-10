import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LeagueStandingsCalculator } from './league-standings.calculator';
import { CupStandingsCalculator } from './cup-standings.calculator';
import { PlayerStatisticsCalculator } from './player-statistics.calculator';
import { Prisma } from '@prisma/client';
import { getSeasonGender } from '../common/season-gender';

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
      const seasonGender = getSeasonGender(season.name) ?? 'MALE';

      const matchesWhere: Prisma.MatchWhereInput = {
        seasonId,
        deletedAt: null,
        status: 'finished',
        ...(seasonType === 'LEAGUE' ? { OR: [{ stage: 'LEAGUE' }, { stage: null }] } : {}),
      };

      const matches = await this.prisma.match.findMany({
        where: matchesWhere,
        include: { goals: true, events: true },
      });

      let isFinished = false;
      if (seasonType === 'LEAGUE') {
        const stageFilter = { OR: [{ stage: 'LEAGUE' }, { stage: null }] };
        const [pendingMatchesCount, finishedMatchesCount] = await Promise.all([
          this.prisma.match.count({
            where: {
              seasonId,
              ...stageFilter,
              deletedAt: null,
              status: { in: ['scheduled', 'ongoing'] },
            },
          }),
          this.prisma.match.count({
            where: { seasonId, ...stageFilter, deletedAt: null, status: 'finished' },
          }),
        ]);
        isFinished = finishedMatchesCount > 0 && pendingMatchesCount === 0;
      }

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

      let champion: any = null;
      let championSource: 'AUTO' | 'MANUAL' | null = null;
      let championResolved = false;

      const manualChampion =
        season.manualChampionTeamId && Array.isArray(standings)
          ? standings.find((row) => row.teamId === season.manualChampionTeamId)
          : null;

      if (manualChampion) {
        champion = manualChampion;
        championSource = 'MANUAL';
        championResolved = true;
      } else if (isFinished && Array.isArray(standings) && standings.length > 0) {
        const topTeam = standings[0];
        const secondTeam = standings[1];
        if (!secondTeam || !topTeam.isTiedWithNext) {
          champion = topTeam;
          championSource = 'AUTO';
          championResolved = true;
        } else {
          champion = null;
          championSource = null;
          championResolved = false;
        }
      } else {
        champion = null;
        championSource = null;
        championResolved = false;
      }

      const standingsCacheData =
        seasonType === 'CUP'
          ? standings
          : {
              type: 'LEAGUE',
              rows: standings,
              isFinished,
              champion,
              championSource,
              championResolved,
            };

      // 计算球员统计
      const stats = await this.playerStatsCalculator.calculate(matches, databaseTeams);

      // 更新缓存
      await this.prisma.season.update({
        where: { id: seasonId },
        data: {
          standingsCache: standingsCacheData as unknown as Prisma.InputJsonValue,
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
