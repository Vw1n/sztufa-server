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

      return {
        data,
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
    return publicMatch;
  }

  findDetails(id: string) {
    return this.prisma.match.findUnique({
      where: { id },
      select: matchDetails,
    });
  }
}
