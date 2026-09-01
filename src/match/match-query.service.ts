import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { publicPlayerFieldsSelect, publicTeamSelect } from '../common/dto/public-response.dto';

const matchDetails = {
  id: true,
  homeTeamId: true,
  awayTeamId: true,
  homeScore: true,
  awayScore: true,
  homePenaltyScore: true,
  awayPenaltyScore: true,
  winnerTeamId: true,
  decidedBy: true,
  matchDate: true,
  location: true,
  status: true,
  seasonId: true,
  mvpPlayerId: true,
  mvpPlayerName: true,
  stage: true,
  groupName: true,
  knockoutRound: true,
  knockoutMatchIndex: true,
  createdAt: true,
  updatedAt: true,
  homeTeam: { select: publicTeamSelect },
  awayTeam: { select: publicTeamSelect },
  goals: true,
  events: true,
  lineups: { include: { player: { select: publicPlayerFieldsSelect } } },
} as const;

@Injectable()
export class MatchQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    page: number = 1,
    limit: number = 10,
    teamId?: string,
    seasonId?: string,
    status?: string,
    stage?: string,
    groupName?: string,
    knockoutRound?: string,
  ) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
        select: { id: true },
      });
      if (activeSeason) targetSeasonId = activeSeason.id;
    }

    const where: any = { deletedAt: null };
    if (targetSeasonId && targetSeasonId !== 'all') where.seasonId = targetSeasonId;
    if (status && status !== 'all') where.status = status;
    if (teamId) where.OR = [{ homeTeamId: teamId }, { awayTeamId: teamId }];
    if (stage) where.stage = stage;
    if (groupName) where.groupName = groupName;
    if (knockoutRound) where.knockoutRound = knockoutRound;

    const whereStats = { ...where };
    delete whereStats.status;

    try {
      const [data, total, statusGroups] = await Promise.all([
        this.prisma.match.findMany({
          skip,
          take: limitNum,
          where,
          select: matchDetails,
          orderBy: { matchDate: 'desc' },
        }),
        this.prisma.match.count({ where }),
        this.prisma.match.groupBy({
          by: ['status'],
          where: whereStats,
          _count: { _all: true },
        }),
      ]);

      const statusCounts = Object.fromEntries(
        statusGroups.map((group) => [group.status, group._count._all]),
      );
      const statsTotal = statusGroups.reduce((sum, group) => sum + group._count._all, 0);
      const enrichedData = await this.enrichMatchesWithSeasonSnapshot(data);

      return {
        data: enrichedData,
        total,
        page: pageNum,
        limit: limitNum,
        stats: {
          total: statsTotal,
          completed: statusCounts.finished || 0,
          scheduled: statusCounts.scheduled || 0,
          ongoing: statusCounts.ongoing || 0,
        },
      };
    } catch (error) {
      console.error('[MatchQueryService.findAll Error]', error);
      try {
        const [data, total] = await Promise.all([
          this.prisma.match.findMany({
            skip,
            take: limitNum,
            where,
            include: { homeTeam: true, awayTeam: true },
            orderBy: { matchDate: 'desc' },
          }),
          this.prisma.match.count({ where }),
        ]);
        return {
          data: data.map((m) => ({ ...m, goals: [], events: [], lineups: [] })),
          total,
          page: pageNum,
          limit: limitNum,
          stats: { total, completed: 0, scheduled: 0, ongoing: 0 },
        };
      } catch (fallbackErr) {
        console.error('[MatchQueryService.findAll Fallback Error]', fallbackErr);
        return {
          data: [],
          total: 0,
          page: pageNum,
          limit: limitNum,
          stats: { total: 0, completed: 0, scheduled: 0, ongoing: 0 },
        };
      }
    }
  }

  async findOne(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      select: { ...matchDetails, deletedAt: true },
    });
    if (!match || match.deletedAt !== null) {
      throw new NotFoundException('比赛不存在');
    }
    const { deletedAt: _deletedAt, ...publicMatch } = match;
    const enriched = await this.enrichMatchesWithSeasonSnapshot([publicMatch]);
    return enriched[0];
  }

  async findDetails(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      select: matchDetails,
    });
    if (!match) return null;
    const enriched = await this.enrichMatchesWithSeasonSnapshot([match]);
    return enriched[0];
  }

  private async enrichMatchesWithSeasonSnapshot(matches: any[]) {
    if (!matches || matches.length === 0) return matches;

    const seasonIds = new Set<string>();

    matches.forEach((m) => {
      if (m?.seasonId) {
        seasonIds.add(m.seasonId);
      }
    });

    if (seasonIds.size === 0) return matches;

    const [profiles, seasonPlayers] = await Promise.all([
      this.prisma.seasonTeamProfile
        ? this.prisma.seasonTeamProfile.findMany({
            where: { seasonId: { in: Array.from(seasonIds) } },
            select: {
              seasonId: true,
              teamId: true,
              teamName: true,
              teamLogo: true,
              homeJerseyColor: true,
              awayJerseyColor: true,
              gender: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.seasonTeamPlayer
        ? this.prisma.seasonTeamPlayer.findMany({
            where: { seasonId: { in: Array.from(seasonIds) } },
            select: {
              seasonId: true,
              playerId: true,
              playerName: true,
              jerseyNumber: true,
              playerPhoto: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const profileMap = new Map(
      (profiles || []).map((p: any) => [`${p.seasonId}_${p.teamId}`, p]),
    );
    const seasonPlayerMap = new Map(
      (seasonPlayers || []).map((sp: any) => [`${sp.seasonId}_${sp.playerId}`, sp]),
    );

    return matches.map((m) => {
      if (!m || !m.seasonId) return m;

      const homeProfile = profileMap.get(`${m.seasonId}_${m.homeTeamId}`);
      const awayProfile = profileMap.get(`${m.seasonId}_${m.awayTeamId}`);

      const enrichedHomeTeam =
        homeProfile && m.homeTeam
          ? {
              ...m.homeTeam,
              teamName: homeProfile.teamName || m.homeTeam.teamName,
              teamLogo: homeProfile.teamLogo || m.homeTeam.teamLogo,
              homeJerseyColor: homeProfile.homeJerseyColor || m.homeTeam.homeJerseyColor,
              awayJerseyColor: homeProfile.awayJerseyColor || m.homeTeam.awayJerseyColor,
              gender: homeProfile.gender || m.homeTeam.gender,
            }
          : m.homeTeam;

      const enrichedAwayTeam =
        awayProfile && m.awayTeam
          ? {
              ...m.awayTeam,
              teamName: awayProfile.teamName || m.awayTeam.teamName,
              teamLogo: awayProfile.teamLogo || m.awayTeam.teamLogo,
              homeJerseyColor: awayProfile.homeJerseyColor || m.awayTeam.homeJerseyColor,
              awayJerseyColor: awayProfile.awayJerseyColor || m.awayTeam.awayJerseyColor,
              gender: awayProfile.gender || m.awayTeam.gender,
            }
          : m.awayTeam;

      const enrichedLineups = Array.isArray(m.lineups)
        ? m.lineups.map((l: any) => {
            const sp = seasonPlayerMap.get(`${m.seasonId}_${l.playerId}`);
            if (sp && l.player) {
              return {
                ...l,
                player: {
                  ...l.player,
                  name: sp.playerName || l.player.name,
                  jerseyNumber: sp.jerseyNumber || l.player.jerseyNumber,
                  photo: sp.playerPhoto || l.player.photo,
                },
              };
            }
            return l;
          })
        : m.lineups;

      return {
        ...m,
        homeTeam: enrichedHomeTeam,
        awayTeam: enrichedAwayTeam,
        lineups: enrichedLineups,
      };
    });
  }
}
