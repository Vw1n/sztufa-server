import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PredictionChoice } from '@prisma/client';
import { MatchEventType } from '../match/dto/create-match.dto';

export function maskStudentId(studentId?: string | null): string {
  if (!studentId) return '未绑定';
  if (studentId.length <= 6) return studentId[0] + '****' + studentId.slice(-1);
  return studentId.slice(0, 4) + '****' + studentId.slice(-2);
}

export interface LeaderboardItem {
  rank: number;
  userId: string;
  username: string;
  nickname: string;
  maskedStudentId: string;
  points: number;
  correctCount: number;
  totalCount: number;
  accuracyRate: number;
}

@Injectable()
export class PredictionService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getMatchesForPrediction(
    userId?: string,
    seasonId?: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const where: any = {
      deletedAt: null,
      status: { in: ['scheduled', 'ongoing', 'finished'] },
    };

    if (seasonId) {
      where.seasonId = seasonId;
    }

    const [total, matches] = await Promise.all([
      this.prisma.match.count({ where }),
      this.prisma.match.findMany({
        where,
        include: {
          homeTeam: { select: { id: true, teamName: true, teamLogo: true } },
          awayTeam: { select: { id: true, teamName: true, teamLogo: true } },
          season: { select: { id: true, name: true } },
        },
        orderBy: [{ matchDate: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const userPredictionsMap = new Map<string, any>();
    if (userId) {
      const matchIds = matches.map((m) => m.id);
      const userPredictions = await this.prisma.prediction.findMany({
        where: {
          userId,
          matchId: { in: matchIds },
        },
      });
      userPredictions.forEach((p) => {
        userPredictionsMap.set(p.matchId, p);
      });
    }

    const now = new Date();

    const data = matches.map((match) => {
      const deadline = new Date(match.matchDate.getTime() - 5 * 60 * 1000);
      const isClosed = now >= deadline || match.status !== 'scheduled';
      const userPred = userPredictionsMap.get(match.id);

      return {
        ...match,
        deadline: deadline.toISOString(),
        isClosed,
        userPrediction: userPred
          ? {
              id: userPred.id,
              choice: userPred.choice,
              status: userPred.status,
              awardedPoints: userPred.awardedPoints,
              submittedAt: userPred.submittedAt,
            }
          : null,
      };
    });

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async getMatchPredictionDetail(matchId: string, userId?: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        homeTeam: { select: { id: true, teamName: true, teamLogo: true } },
        awayTeam: { select: { id: true, teamName: true, teamLogo: true } },
        season: { select: { id: true, name: true } },
      },
    });

    if (!match || match.deletedAt) {
      throw new NotFoundException('比赛不存在');
    }

    const now = new Date();
    const deadline = new Date(match.matchDate.getTime() - 5 * 60 * 1000);
    const isClosed = now >= deadline || match.status !== 'scheduled';

    let userPrediction = null;
    if (userId) {
      const pred = await this.prisma.prediction.findUnique({
        where: { userId_matchId: { userId, matchId } },
      });
      if (pred) {
        userPrediction = {
          id: pred.id,
          choice: pred.choice,
          status: pred.status,
          awardedPoints: pred.awardedPoints,
          submittedAt: pred.submittedAt,
        };
      }
    }

    return {
      ...match,
      deadline: deadline.toISOString(),
      isClosed,
      userPrediction,
    };
  }

  async submitPrediction(userId: string, matchId: string, choice: PredictionChoice) {
    const user = await this.prisma.memberAccount.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    if (user.disabled || user.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException('校园卡审核通过后才能参与竞猜');
    }

    if (!user.studentId || !user.studentId.trim()) {
      throw new ForbiddenException('必须绑定学号后才能参加竞猜');
    }

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });

    if (!match || match.deletedAt) {
      throw new NotFoundException('比赛不存在');
    }

    if (match.status !== 'scheduled') {
      throw new BadRequestException('该比赛当前状态不允许进行竞猜');
    }

    const now = new Date();
    const deadline = new Date(match.matchDate.getTime() - 5 * 60 * 1000);
    if (now >= deadline) {
      throw new BadRequestException('该比赛已过竞猜截止时间（开赛前 5 分钟停止竞猜）');
    }

    const prediction = await this.prisma.prediction.upsert({
      where: {
        userId_matchId: { userId, matchId },
      },
      create: {
        userId,
        matchId,
        choice,
        status: 'PENDING',
        awardedPoints: 0,
        submittedAt: now,
      },
      update: {
        choice,
        status: 'PENDING',
        awardedPoints: 0,
        submittedAt: now,
      },
    });

    return prediction;
  }

  async getMyPredictions(userId: string, seasonId?: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const matchWhere: any = {};
    if (seasonId) {
      matchWhere.seasonId = seasonId;
    }

    const where: any = {
      userId,
      ...(Object.keys(matchWhere).length > 0 ? { match: matchWhere } : {}),
    };

    const [total, predictions] = await Promise.all([
      this.prisma.prediction.count({ where }),
      this.prisma.prediction.findMany({
        where,
        include: {
          match: {
            include: {
              homeTeam: { select: { id: true, teamName: true, teamLogo: true } },
              awayTeam: { select: { id: true, teamName: true, teamLogo: true } },
              season: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { submittedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: predictions,
      total,
      page,
      limit,
    };
  }

  async getMyStats(userId: string, seasonId?: string) {
    const user = await this.prisma.memberAccount.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const allSettledPredictions = await this.prisma.prediction.findMany({
      where: {
        userId,
        status: { in: ['CORRECT', 'WRONG'] },
      },
      include: {
        match: { select: { seasonId: true } },
      },
    });

    const totalPoints = allSettledPredictions.reduce((sum, p) => sum + p.awardedPoints, 0);
    const totalPredictions = allSettledPredictions.length;
    const correctPredictions = allSettledPredictions.filter((p) => p.status === 'CORRECT').length;
    const accuracyRate =
      totalPredictions > 0 ? Number(((correctPredictions / totalPredictions) * 100).toFixed(1)) : 0;

    let seasonPoints = 0;
    let seasonRank = 0;

    if (seasonId) {
      const seasonPredictions = allSettledPredictions.filter((p) => p.match?.seasonId === seasonId);
      seasonPoints = seasonPredictions.reduce((sum, p) => sum + p.awardedPoints, 0);

      const leaderboard = await this.getLeaderboard('season', seasonId, userId);
      seasonRank = leaderboard.currentUser?.rank ?? 0;
    }

    return {
      totalPoints,
      seasonPoints,
      seasonRank,
      totalPredictions,
      correctPredictions,
      accuracyRate,
    };
  }

  async getLeaderboard(
    scope: 'season' | 'all' = 'season',
    seasonId?: string,
    currentUserId?: string,
  ) {
    if (scope === 'season') {
      let targetSeasonId = seasonId;
      if (!targetSeasonId || !targetSeasonId.trim()) {
        const activeSeason = await this.prisma.season.findFirst({
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' },
        });
        if (activeSeason) {
          targetSeasonId = activeSeason.id;
        } else {
          const latestSeason = await this.prisma.season.findFirst({
            orderBy: { createdAt: 'desc' },
          });
          if (latestSeason) {
            targetSeasonId = latestSeason.id;
          }
        }
      }

      if (!targetSeasonId) {
        return { list: [], currentUser: null };
      }

      seasonId = targetSeasonId;
      const season = await this.prisma.season.findUnique({
        where: { id: seasonId },
      });
      if (!season) {
        throw new BadRequestException('指定的赛季不存在');
      }
    }

    const userWhere: any = {
      disabled: false,
      studentId: { not: null },
    };

    const regularUsers = await this.prisma.memberAccount.findMany({
      where: userWhere,
      select: {
        id: true,
        username: true,
        nickname: true,
        studentId: true,
      },
    });

    if (regularUsers.length === 0) {
      return { list: [], currentUser: null };
    }

    const userIds = regularUsers.map((u) => u.id);

    const predictionWhere: any = {
      userId: { in: userIds },
      status: { in: ['CORRECT', 'WRONG'] },
      match: { deletedAt: null },
    };

    if (scope === 'season' && seasonId) {
      predictionWhere.match = { ...predictionWhere.match, seasonId };
    }

    const predictions = await this.prisma.prediction.findMany({
      where: predictionWhere,
      select: {
        userId: true,
        status: true,
        awardedPoints: true,
      },
    });

    const userStatsMap = new Map<
      string,
      { points: number; correctCount: number; totalCount: number }
    >();

    regularUsers.forEach((u) => {
      userStatsMap.set(u.id, { points: 0, correctCount: 0, totalCount: 0 });
    });

    predictions.forEach((p) => {
      const stat = userStatsMap.get(p.userId);
      if (stat) {
        stat.points += p.awardedPoints;
        stat.totalCount += 1;
        if (p.status === 'CORRECT') {
          stat.correctCount += 1;
        }
      }
    });

    const allUserList: LeaderboardItem[] = regularUsers.map((u) => {
      const stat = userStatsMap.get(u.id) || {
        points: 0,
        correctCount: 0,
        totalCount: 0,
      };
      const accuracyRate =
        stat.totalCount > 0 ? Number(((stat.correctCount / stat.totalCount) * 100).toFixed(1)) : 0;

      return {
        rank: 0,
        userId: u.id,
        username: u.username,
        nickname: u.nickname || u.username,
        maskedStudentId: maskStudentId(u.studentId),
        points: stat.points,
        correctCount: stat.correctCount,
        totalCount: stat.totalCount,
        accuracyRate,
      };
    });

    // Filter out zero-participation accounts from the main public leaderboard
    const activeUserList = allUserList.filter((u) => u.totalCount > 0);

    activeUserList.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.accuracyRate !== a.accuracyRate) return b.accuracyRate - a.accuracyRate;
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      return a.username.localeCompare(b.username);
    });

    for (let i = 0; i < activeUserList.length; i++) {
      if (i === 0) {
        activeUserList[i].rank = 1;
      } else {
        const prev = activeUserList[i - 1];
        const curr = activeUserList[i];
        if (
          curr.points === prev.points &&
          curr.accuracyRate === prev.accuracyRate &&
          curr.totalCount === prev.totalCount
        ) {
          curr.rank = prev.rank;
        } else {
          curr.rank = i + 1;
        }
      }
    }

    const top100 = activeUserList.slice(0, 100);

    let currentUserItem: LeaderboardItem | null = null;
    if (currentUserId) {
      const foundInActive = activeUserList.find((u) => u.userId === currentUserId);
      if (foundInActive) {
        currentUserItem = foundInActive;
      } else {
        const unrankedUser = allUserList.find((u) => u.userId === currentUserId);
        if (unrankedUser) {
          currentUserItem = { ...unrankedUser, rank: 0 };
        }
      }
    }

    return {
      list: top100,
      currentUser: currentUserItem,
    };
  }

  async settleMatchPredictions(matchId: string, txPrisma?: any) {
    const db = txPrisma || this.prisma;

    const match = await db.match.findUnique({
      where: { id: matchId },
      include: {
        events: {
          select: {
            eventType: true,
            teamType: true,
            phase: true,
          },
        },
      },
    });

    if (!match || match.deletedAt) {
      return { settledCount: 0 };
    }

    let regularHomeScore = 0;
    let regularAwayScore = 0;

    let hasGoalEvents = false;
    const regularEvents = match.events.filter((e: any) => !e.phase || e.phase === 'REGULAR');

    if (regularEvents.length > 0) {
      regularEvents.forEach((event: any) => {
        const lowerType = (event.eventType || '').toLowerCase();
        if (
          lowerType === MatchEventType.Goal ||
          lowerType === MatchEventType.Penalty ||
          lowerType === 'goal' ||
          lowerType === 'penalty'
        ) {
          hasGoalEvents = true;
          if (event.teamType === 'home') regularHomeScore += 1;
          if (event.teamType === 'away') regularAwayScore += 1;
        }
        if (lowerType === MatchEventType.OwnGoal || lowerType === 'own_goal') {
          hasGoalEvents = true;
          if (event.teamType === 'home') regularAwayScore += 1;
          if (event.teamType === 'away') regularHomeScore += 1;
        }
      });
    }

    if (!hasGoalEvents) {
      regularHomeScore = match.homeScore || 0;
      regularAwayScore = match.awayScore || 0;
    }

    let outcomeChoice: PredictionChoice = PredictionChoice.DRAW;
    if (regularHomeScore > regularAwayScore) {
      outcomeChoice = PredictionChoice.HOME_WIN;
    } else if (regularHomeScore < regularAwayScore) {
      outcomeChoice = PredictionChoice.AWAY_WIN;
    } else {
      outcomeChoice = PredictionChoice.DRAW;
    }

    const pendingOrSettled = await db.prediction.findMany({
      where: {
        matchId,
        status: { in: ['PENDING', 'CORRECT', 'WRONG'] },
      },
    });

    const now = new Date();

    for (const pred of pendingOrSettled) {
      const isCorrect = pred.choice === outcomeChoice;
      await db.prediction.update({
        where: { id: pred.id },
        data: {
          status: isCorrect ? 'CORRECT' : 'WRONG',
          awardedPoints: isCorrect ? 3 : 0,
          settledAt: now,
        },
      });
    }

    return { settledCount: pendingOrSettled.length };
  }

  async voidMatchPredictions(matchId: string, username: string, txPrisma?: any) {
    const db = txPrisma || this.prisma;

    const match = await db.match.findUnique({
      where: { id: matchId },
      include: { homeTeam: true, awayTeam: true },
    });

    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    const [predictionCount, activePredictionCount] = await Promise.all([
      db.prediction.count({ where: { matchId } }),
      db.prediction.count({
        where: {
          matchId,
          status: { not: 'VOID' },
        },
      }),
    ]);

    if (predictionCount > 0 && activePredictionCount === 0) {
      return {
        voidedCount: 0,
        message: '该比赛的所有竞猜已处于作废状态，无需重复作废',
        previousStatus: match.status,
      };
    }

    if (predictionCount === 0) {
      return {
        voidedCount: 0,
        message: '该比赛暂无竞猜记录',
        previousStatus: match.status,
      };
    }

    const result = await db.prediction.updateMany({
      where: {
        matchId,
        status: { not: 'VOID' },
      },
      data: {
        status: 'VOID',
        awardedPoints: 0,
        settledAt: new Date(),
      },
    });

    await this.auditLogService.log(
      username,
      'VOID_PREDICTIONS',
      `作废比赛 "${match.homeTeam?.teamName} vs ${match.awayTeam?.teamName}" 的全部竞猜记录(${result.count}条)`,
      db,
    );

    return {
      voidedCount: result.count,
      previousStatus: match.status,
    };
  }

  async recalculateMatchPredictions(matchId: string, username: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { homeTeam: true, awayTeam: true },
    });

    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    if (match.status !== 'finished') {
      throw new BadRequestException(
        `非完赛状态的比赛（当前状态为: ${match.status}）禁止手动触发竞猜结算`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const result = await this.settleMatchPredictions(matchId, tx);
      await this.auditLogService.log(
        username,
        'RECALCULATE_PREDICTIONS',
        `手动重新结算比赛 "${match.homeTeam?.teamName} vs ${match.awayTeam?.teamName}" 的竞猜(${result.settledCount}条)`,
        tx,
      );
      return result;
    });
  }
}
