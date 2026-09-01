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
      const season = await this.prisma.season.findUnique({
        where: { id: seasonId },
        select: { id: true, name: true, type: true },
      });
      if (!season) return { success: false, error: '赛季不存在' };

      const seasonType = season.type || 'LEAGUE';
      const seasonGender =
        season.name.includes('女') || season.name.includes('女子') ? 'FEMALE' : 'MALE';

      const matches = await this.prisma.match.findMany({
        where: { seasonId, deletedAt: null, status: 'finished' },
        include: { goals: true, events: true },
      });

      const [seasonProfiles, seasonPlayers, allTeams] = await Promise.all([
        this.prisma.seasonTeamProfile
          ? this.prisma.seasonTeamProfile.findMany({
              where: { seasonId },
              select: {
                teamId: true,
                teamName: true,
                teamLogo: true,
                gender: true,
              },
            })
          : Promise.resolve([]),
        this.prisma.seasonTeamPlayer
          ? this.prisma.seasonTeamPlayer.findMany({
              where: { seasonId },
              select: {
                teamId: true,
                team: { select: { id: true, teamName: true, teamLogo: true, gender: true } },
              },
            })
          : Promise.resolve([]),
        this.prisma.team.findMany({
          select: { id: true, teamName: true, teamLogo: true, gender: true },
        }),
      ]);

      const seasonProfilesMap = new Map((seasonProfiles || []).map((p: any) => [p.teamId, p]));
      const databaseTeams = new Map(allTeams.map((team) => [team.id, team]));
      const teamsMap = new Map<string, { id: string; teamName: string; teamLogo: string }>();

      // 1. 优先从 SeasonTeamProfile 获取符合赛季性别的球队快照
      (seasonProfiles || []).forEach((profile: any) => {
        if (profile.gender === seasonGender) {
          teamsMap.set(profile.teamId, {
            id: profile.teamId,
            teamName: profile.teamName,
            teamLogo: profile.teamLogo || '',
          });
        }
      });

      // 2. 补充 seasonPlayers 中尚未包含的球队
      (seasonPlayers || []).forEach((seasonPlayer: any) => {
        if (!teamsMap.has(seasonPlayer.teamId)) {
          const profile = seasonProfilesMap.get(seasonPlayer.teamId);
          const team = seasonPlayer.team || databaseTeams.get(seasonPlayer.teamId);
          const gender = profile?.gender || team?.gender;
          if (gender === seasonGender) {
            teamsMap.set(seasonPlayer.teamId, {
              id: seasonPlayer.teamId,
              teamName: profile?.teamName || team?.teamName || '',
              teamLogo: profile?.teamLogo || team?.teamLogo || '',
            });
          }
        }
      });

      // 3. 确保比赛中出现的球队也在 teamsMap 中
      matches.forEach((match) => {
        const addTeamIfValid = (teamId: string) => {
          if (teamsMap.has(teamId)) return;
          const profile = seasonProfilesMap.get(teamId);
          const team = databaseTeams.get(teamId);
          const gender = profile?.gender || team?.gender;
          if (gender === seasonGender) {
            teamsMap.set(teamId, {
              id: teamId,
              teamName: profile?.teamName || team?.teamName || '',
              teamLogo: profile?.teamLogo || team?.teamLogo || '',
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
      const stats = await this.playerStatsCalculator.calculate(matches, databaseTeams, seasonId);

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
