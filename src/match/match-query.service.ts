import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const matchDetails = {
  homeTeam: true,
  awayTeam: true,
  goals: true,
  events: true,
  lineups: { include: { player: true } },
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
      const [data, total, allMatchesForStats] = await Promise.all([
        this.prisma.match.findMany({
          skip,
          take: limitNum,
          where,
          include: matchDetails,
          orderBy: { matchDate: 'desc' },
        }),
        this.prisma.match.count({ where }),
        this.prisma.match.findMany({ where: whereStats, select: { status: true } }),
      ]);

      return {
        data,
        total,
        page: pageNum,
        limit: limitNum,
        stats: {
          total: allMatchesForStats.length,
          completed: allMatchesForStats.filter((match) => match.status === 'finished').length,
          scheduled: allMatchesForStats.filter((match) => match.status === 'scheduled').length,
          ongoing: allMatchesForStats.filter((match) => match.status === 'ongoing').length,
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
      include: matchDetails,
    });
    if (!match || match.deletedAt !== null) {
      throw new NotFoundException('比赛不存在');
    }
    return match;
  }

  findDetails(id: string) {
    return this.prisma.match.findUnique({
      where: { id },
      include: matchDetails,
    });
  }
}
