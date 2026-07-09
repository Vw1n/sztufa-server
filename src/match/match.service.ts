import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { UpdateMatchDto } from './dto/update-match.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(createMatchDto: CreateMatchDto, username: string) {
    const [homeTeam, awayTeam] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: createMatchDto.homeTeamId } }),
      this.prisma.team.findUnique({ where: { id: createMatchDto.awayTeamId } }),
    ]);

    if (!homeTeam) {
      throw new NotFoundException('主队不存在');
    }
    if (!awayTeam) {
      throw new NotFoundException('客队不存在');
    }

    // 获取当前活跃赛季并进行关联
    const activeSeason = await this.prisma.season.findFirst({
      where: { status: 'active' },
    });
    const seasonId = activeSeason ? activeSeason.id : null;

    const { goals, events, ...matchData } = createMatchDto;
    const match = await this.prisma.match.create({
      data: {
        ...matchData,
        seasonId,
      },
      include: { homeTeam: true, awayTeam: true },
    });

    if (events && events.length > 0) {
      await this.prisma.matchEvent.createMany({
        data: events.map((e) => ({
          matchId: match.id,
          eventTime: e.eventTime,
          eventType: e.eventType,
          description: e.description,
          teamType: e.teamType,
          playerId: e.playerId || null,
          playerName: e.playerName || null,
          jerseyNumber: e.jerseyNumber || null,
          subPlayerId: e.subPlayerId || null,
          subPlayerName: e.subPlayerName || null,
          subJerseyNumber: e.subJerseyNumber || null,
          assistPlayerId: e.assistPlayerId || null,
          assistPlayerName: e.assistPlayerName || null,
          assistJerseyNumber: e.assistJerseyNumber || null,
        })),
      });
    }

    // 自动同步进球记录到 Goal 表以向下兼容展示端
    const goalEvents = events
      ? events.filter(
          (e) => e.eventType === 'goal' || e.eventType === 'penalty' || e.eventType === 'own_goal',
        )
      : [];
    if (goalEvents.length > 0) {
      await this.prisma.goal.createMany({
        data: goalEvents.map((g) => ({
          matchId: match.id,
          playerName:
            g.eventType === 'own_goal'
              ? `${g.playerName} (乌龙)`
              : g.eventType === 'penalty'
                ? `${g.playerName} (点球)`
                : g.playerName || '',
          jerseyNumber: g.jerseyNumber || '',
          goalTime: g.eventTime,
          teamType:
            g.eventType === 'own_goal' ? (g.teamType === 'home' ? 'away' : 'home') : g.teamType,
          playerId: g.playerId || null,
        })),
      });
    } else if (goals && goals.length > 0) {
      await this.prisma.goal.createMany({
        data: goals.map((g) => ({
          matchId: match.id,
          playerName: g.playerName,
          jerseyNumber: g.jerseyNumber,
          goalTime: g.goalTime,
          teamType: g.teamType,
          playerId: g.playerId || null,
        })),
      });
    }

    // 同步本场比赛受影响和停赛球员的红黄牌与可用状态
    await this.syncMatchPlayers(
      match.id,
      match.homeTeamId,
      match.awayTeamId,
      match.status,
      events || [],
      this.prisma,
    );

    // 记录审计日志
    await this.auditLogService.log(
      username,
      'CREATE_MATCH',
      `录入了比赛比分与事件: ${homeTeam.teamName} vs ${awayTeam.teamName} (比分: ${createMatchDto.homeScore}:${createMatchDto.awayScore})`,
    );

    return this.prisma.match.findUnique({
      where: { id: match.id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
  }

  async findAll(page: number = 1, limit: number = 10, teamId?: string, seasonId?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
      });
      if (activeSeason) {
        targetSeasonId = activeSeason.id;
      }
    }

    const where: any = {};
    if (targetSeasonId && targetSeasonId !== 'all') {
      where.seasonId = targetSeasonId;
    }
    if (teamId) {
      where.OR = [{ homeTeamId: teamId }, { awayTeamId: teamId }];
    }

    const [data, total] = await Promise.all([
      this.prisma.match.findMany({
        skip,
        take: limitNum,
        where,
        include: { homeTeam: true, awayTeam: true, goals: true, events: true },
        orderBy: { matchDate: 'desc' },
      }),
      this.prisma.match.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }
    return match;
  }

  async update(id: string, updateMatchDto: UpdateMatchDto, username: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    if (updateMatchDto.homeTeamId) {
      const homeTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.homeTeamId },
      });
      if (!homeTeam) {
        throw new NotFoundException('主队不存在');
      }
    }

    if (updateMatchDto.awayTeamId) {
      const awayTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.awayTeamId },
      });
      if (!awayTeam) {
        throw new NotFoundException('客队不存在');
      }
    }

    const { goals, events, ...matchData } = updateMatchDto;

    await this.prisma.match.update({
      where: { id },
      data: matchData,
    });

    // 同步比赛事件数据
    await this.prisma.matchEvent.deleteMany({ where: { matchId: id } });
    if (events && events.length > 0) {
      await this.prisma.matchEvent.createMany({
        data: events.map((e) => ({
          matchId: id,
          eventTime: e.eventTime,
          eventType: e.eventType,
          description: e.description,
          teamType: e.teamType,
          playerId: e.playerId || null,
          playerName: e.playerName || null,
          jerseyNumber: e.jerseyNumber || null,
          subPlayerId: e.subPlayerId || null,
          subPlayerName: e.subPlayerName || null,
          subJerseyNumber: e.subJerseyNumber || null,
          assistPlayerId: e.assistPlayerId || null,
          assistPlayerName: e.assistPlayerName || null,
          assistJerseyNumber: e.assistJerseyNumber || null,
        })),
      });
    }

    // 同步进球数据到 Goal 表（向下兼容展示端）
    await this.prisma.goal.deleteMany({ where: { matchId: id } });
    const goalEvents = events
      ? events.filter(
          (e) => e.eventType === 'goal' || e.eventType === 'penalty' || e.eventType === 'own_goal',
        )
      : [];
    if (goalEvents.length > 0) {
      await this.prisma.goal.createMany({
        data: goalEvents.map((g) => ({
          matchId: id,
          playerName:
            g.eventType === 'own_goal'
              ? `${g.playerName} (乌龙)`
              : g.eventType === 'penalty'
                ? `${g.playerName} (点球)`
                : g.playerName || '',
          jerseyNumber: g.jerseyNumber || '',
          goalTime: g.eventTime,
          teamType:
            g.eventType === 'own_goal' ? (g.teamType === 'home' ? 'away' : 'home') : g.teamType,
          playerId: g.playerId || null,
        })),
      });
    } else if (goals && goals.length > 0) {
      await this.prisma.goal.createMany({
        data: goals.map((g) => ({
          matchId: id,
          playerName: g.playerName,
          jerseyNumber: g.jerseyNumber,
          goalTime: g.goalTime,
          teamType: g.teamType,
          playerId: g.playerId || null,
        })),
      });
    }

    // 重新计算并同步所有受影响球员和需解禁停赛球员的状态
    const updatedMatch = await this.prisma.match.findUnique({ where: { id } });
    await this.syncMatchPlayers(
      id,
      updatedMatch.homeTeamId,
      updatedMatch.awayTeamId,
      updatedMatch.status,
      events || [],
      this.prisma,
    );

    // 记录审计日志
    const homeTeamName = match.homeTeam?.teamName || '';
    const awayTeamName = match.awayTeam?.teamName || '';
    await this.auditLogService.log(
      username,
      'UPDATE_MATCH',
      `修改了比赛信息与比分: ${homeTeamName} vs ${awayTeamName} (比分由 ${match.homeScore}:${match.awayScore} 变更为 ${updateMatchDto.homeScore ?? match.homeScore}:${updateMatchDto.awayScore ?? match.awayScore})`,
    );

    return this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
  }

  async remove(id: string, username: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    const affectedPlayerIds = new Set<string>();
    match.events.forEach((e) => {
      if (e.playerId) affectedPlayerIds.add(e.playerId);
      if (e.subPlayerId) affectedPlayerIds.add(e.subPlayerId);
      if (e.assistPlayerId) affectedPlayerIds.add(e.assistPlayerId);
    });

    const suspendedPlayers = await this.prisma.player.findMany({
      where: {
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
        status: 'suspended',
      },
    });
    suspendedPlayers.forEach((p) => affectedPlayerIds.add(p.id));

    await this.prisma.match.delete({ where: { id } });

    // 同步受影响球员的状态
    for (const playerId of affectedPlayerIds) {
      await this.syncPlayerCards(playerId, this.prisma);
    }

    await this.auditLogService.log(
      username,
      'DELETE_MATCH',
      `删除了比赛: ${match.homeTeam.teamName} vs ${match.awayTeam.teamName} (比分: ${match.homeScore}:${match.awayScore})`,
    );

    return match;
  }

  async syncMatchPlayers(
    matchId: string,
    homeTeamId: string,
    awayTeamId: string,
    status: string,
    events: any[],
    tx: any = this.prisma,
  ) {
    const affectedPlayerIds = new Set<string>();
    events.forEach((e) => {
      if (e.playerId) affectedPlayerIds.add(e.playerId);
      if (e.subPlayerId) affectedPlayerIds.add(e.subPlayerId);
      if (e.assistPlayerId) affectedPlayerIds.add(e.assistPlayerId);
    });

    if (status === 'finished') {
      const suspendedPlayers = await tx.player.findMany({
        where: {
          teamId: { in: [homeTeamId, awayTeamId] },
          status: 'suspended',
        },
      });
      suspendedPlayers.forEach((p) => affectedPlayerIds.add(p.id));
    }

    for (const playerId of affectedPlayerIds) {
      await this.syncPlayerCards(playerId, tx);
    }
  }

  async syncPlayerCards(playerId: string, tx: any = this.prisma) {
    const activeSeason = await tx.season.findFirst({
      where: { status: 'active' },
    });
    const seasonWhere = activeSeason ? { seasonId: activeSeason.id } : {};

    const events = await tx.matchEvent.findMany({
      where: {
        playerId,
        eventType: { in: ['yellow_card', 'red_card'] },
        match: {
          ...seasonWhere,
          status: { in: ['finished', 'ongoing'] },
        },
      },
      include: {
        match: true,
      },
      orderBy: [{ match: { matchDate: 'asc' } }, { eventTime: 'asc' }],
    });

    const yellowEvents = events.filter((e) => e.eventType === 'yellow_card');
    const redEvents = events.filter((e) => e.eventType === 'red_card');
    const yellows = yellowEvents.length;
    const reds = redEvents.length;

    const triggerMatches: any[] = [];
    redEvents.forEach((e) => {
      if (e.match) triggerMatches.push(e.match);
    });
    yellowEvents.forEach((e, index) => {
      if ((index + 1) % 3 === 0 && e.match) {
        triggerMatches.push(e.match);
      }
    });

    let status = 'active';
    let suspendedAtMatchId: string | null = null;

    if (triggerMatches.length > 0) {
      triggerMatches.sort(
        (a, b) => new Date(b.matchDate).getTime() - new Date(a.matchDate).getTime(),
      );
      const latestTriggerMatch = triggerMatches[0];

      const player = await tx.player.findUnique({
        where: { id: playerId },
      });
      if (player) {
        const servedMatch = await tx.match.findFirst({
          where: {
            ...seasonWhere,
            status: 'finished',
            matchDate: { gt: latestTriggerMatch.matchDate },
            OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
          },
          orderBy: { matchDate: 'asc' },
        });

        if (servedMatch) {
          status = 'active';
          suspendedAtMatchId = null;
        } else {
          status = 'suspended';
          suspendedAtMatchId = latestTriggerMatch.id;
        }
      }
    }

    await tx.player.update({
      where: { id: playerId },
      data: {
        yellowCards: yellows,
        redCards: reds,
        status,
        suspendedAtMatchId,
      },
    });
  }
}
