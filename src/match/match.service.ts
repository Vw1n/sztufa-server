import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { UpdateMatchDto } from './dto/update-match.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PlayerCardSyncService } from './player-card-sync.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { MatchQueryService } from './match-query.service';
import { MatchDataWriterService } from './match-data-writer.service';
import {
  calculateMatchOutcome,
  resolveMatchOutcome,
} from './match-outcome';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly playerCardSyncService: PlayerCardSyncService,
    private readonly seasonStatistics: SeasonStatisticsService,
    private readonly matchQuery: MatchQueryService,
    private readonly matchDataWriter: MatchDataWriterService,
  ) {}

  async create(createMatchDto: CreateMatchDto, username: string) {
    if (createMatchDto.homeTeamId === createMatchDto.awayTeamId) {
      throw new BadRequestException('主队和客队不能是同一支球队');
    }

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
    let seasonId = createMatchDto.seasonId;
    if (!seasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      seasonId = activeSeason ? activeSeason.id : undefined;
    }

    const { goals, events, lineups, seasonId: passedSeasonId, ...matchData } = createMatchDto;
    const outcome = events
      ? calculateMatchOutcome(events)
      : resolveMatchOutcome(matchData.homeScore || 0, matchData.awayScore || 0);
    const winnerTeamId =
      outcome.winnerTeamType === 'home'
        ? createMatchDto.homeTeamId
        : outcome.winnerTeamType === 'away'
          ? createMatchDto.awayTeamId
          : null;

    const { match, validLineups } = await this.prisma.$transaction(async (tx) => {
      const createdMatch = await tx.match.create({
        data: {
          ...matchData,
          homeScore: outcome.homeScore,
          awayScore: outcome.awayScore,
          homePenaltyScore: outcome.homePenaltyScore,
          awayPenaltyScore: outcome.awayPenaltyScore,
          winnerTeamId,
          decidedBy: outcome.decidedBy,
          seasonId,
        },
        include: { homeTeam: true, awayTeam: true },
      });

      const validatedLineups = lineups?.length
        ? await this.matchDataWriter.writeLineups(
            tx,
            createdMatch.id,
            createdMatch.homeTeamId,
            createdMatch.awayTeamId,
            lineups,
          )
        : [];
      await this.matchDataWriter.writeEvents(tx, createdMatch.id, events || []);
      await this.matchDataWriter.writeGoals(tx, createdMatch.id, events, goals);

      return { match: createdMatch, validLineups: validatedLineups };
    });

    // 同步本场比赛受影响和停赛球员的红黄牌与可用状态
    await this.playerCardSyncService.syncMatchPlayers(
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
      `录入比赛: "${homeTeam.teamName} vs ${awayTeam.teamName}" (比分: ${outcome.homeScore}:${outcome.awayScore})`,
    );

    const result = await this.matchQuery.findDetails(match.id);

    if (result && result.seasonId && result.status === 'finished') {
      const cacheResult = await this.seasonStatistics.computeAndCache(result.seasonId);
      if (!cacheResult.success) {
        console.error(`[Match Create] 积分榜缓存更新失败: ${cacheResult.error}`);
      }
    }

    return result;
  }

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
    return this.matchQuery.findAll(
      page,
      limit,
      teamId,
      seasonId,
      status,
      stage,
      groupName,
      knockoutRound,
    );
  }

  async findOne(id: string) {
    return this.matchQuery.findOne(id);
  }

  async update(id: string, updateMatchDto: UpdateMatchDto, username: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    const finalHomeTeamId = updateMatchDto.homeTeamId || match.homeTeamId;
    const finalAwayTeamId = updateMatchDto.awayTeamId || match.awayTeamId;
    if (finalHomeTeamId === finalAwayTeamId) {
      throw new BadRequestException('主队和客队不能是同一支球队');
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

    const { goals, events, lineups, ...matchData } = updateMatchDto;
    const outcome = events
      ? calculateMatchOutcome(events)
      : resolveMatchOutcome(
          updateMatchDto.homeScore ?? match.homeScore,
          updateMatchDto.awayScore ?? match.awayScore,
          match.homePenaltyScore,
          match.awayPenaltyScore,
        );
    const winnerTeamId =
      outcome.winnerTeamType === 'home'
        ? finalHomeTeamId
        : outcome.winnerTeamType === 'away'
          ? finalAwayTeamId
          : null;

    const updatedMatch = await this.prisma.$transaction(async (tx) => {
      await tx.match.update({
        where: { id },
        data: {
          ...matchData,
          homeScore: outcome.homeScore,
          awayScore: outcome.awayScore,
          homePenaltyScore: outcome.homePenaltyScore,
          awayPenaltyScore: outcome.awayPenaltyScore,
          winnerTeamId,
          decidedBy: outcome.decidedBy,
        },
      });

      if (lineups !== undefined) {
        await this.matchDataWriter.replaceLineups(
          tx,
          id,
          finalHomeTeamId,
          finalAwayTeamId,
          lineups,
        );
      }

      if (events !== undefined) {
        await this.matchDataWriter.replaceEvents(tx, id, events);
      }

      if (events !== undefined || goals !== undefined) {
        await this.matchDataWriter.replaceGoals(tx, id, events, goals);
      }

      return tx.match.findUnique({ where: { id } });
    });

    if (!updatedMatch) {
      throw new NotFoundException('同步更新比赛时失败，未找到该场比赛信息');
    }

    // 重新计算并同步所有受影响球员和需解禁停赛球员的状态
    const effectiveEvents = events ?? match.events;
    await this.playerCardSyncService.syncMatchPlayers(
      id,
      updatedMatch.homeTeamId,
      updatedMatch.awayTeamId,
      updatedMatch.status,
      effectiveEvents,
      this.prisma,
    );

    if (events !== undefined) {
      const currentPlayerIds = new Set(
        effectiveEvents.flatMap((event) =>
          [event.playerId, event.subPlayerId, event.assistPlayerId].filter(Boolean),
        ),
      );
      const previousPlayerIds = new Set(
        match.events.flatMap((event) =>
          [event.playerId, event.subPlayerId, event.assistPlayerId].filter(Boolean),
        ),
      );
      for (const playerId of previousPlayerIds) {
        if (!currentPlayerIds.has(playerId)) {
          await this.playerCardSyncService.syncPlayerCards(playerId, this.prisma);
        }
      }
    }

    // 记录审计日志
    const diffs: string[] = [];
    if (updateMatchDto.homeScore !== undefined && updateMatchDto.homeScore !== match.homeScore) {
      diffs.push(`主队比分: ${match.homeScore}->${updateMatchDto.homeScore}`);
    }
    if (updateMatchDto.awayScore !== undefined && updateMatchDto.awayScore !== match.awayScore) {
      diffs.push(`客队比分: ${match.awayScore}->${updateMatchDto.awayScore}`);
    }
    if (updateMatchDto.location !== undefined && updateMatchDto.location !== match.location) {
      diffs.push(`地点: ${match.location || '未定'}->${updateMatchDto.location || '未定'}`);
    }
    if (
      updateMatchDto.matchDate !== undefined &&
      new Date(updateMatchDto.matchDate).getTime() !== new Date(match.matchDate).getTime()
    ) {
      diffs.push(`更新时间`);
    }
    if (updateMatchDto.status !== undefined && updateMatchDto.status !== match.status) {
      diffs.push(`状态: ${match.status}->${updateMatchDto.status}`);
    }
    if (events !== undefined) {
      diffs.push(`更新事件(${events.length}个)`);
    }
    if (lineups !== undefined) {
      diffs.push(`更新阵容`);
    }

    const homeTeamName = match.homeTeam?.teamName || '';
    const awayTeamName = match.awayTeam?.teamName || '';
    const details =
      diffs.length > 0
        ? `修改比赛 "${homeTeamName} vs ${awayTeamName}" 比分/信息: ${diffs.join(', ')}`
        : `保存比赛 "${homeTeamName} vs ${awayTeamName}" 信息(未改动)`;

    await this.auditLogService.log(username, 'UPDATE_MATCH', details);

    const result = await this.matchQuery.findDetails(id);

    if (result && result.seasonId) {
      const cacheResult = await this.seasonStatistics.computeAndCache(result.seasonId);
      if (!cacheResult.success) {
        console.error(`[Match Update] 积分榜缓存更新失败: ${cacheResult.error}`);
      }
    }

    return result;
  }

  async remove(id: string, username: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, events: true },
    });
    if (!match || match.deletedAt !== null) {
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

    // 软删除比赛
    const deletedMatch = await this.prisma.match.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // 同步受影响球员的状态
    for (const playerId of affectedPlayerIds) {
      await this.playerCardSyncService.syncPlayerCards(playerId, this.prisma);
    }

    if (deletedMatch.seasonId) {
      const cacheResult = await this.seasonStatistics.computeAndCache(deletedMatch.seasonId);
      if (!cacheResult.success) {
        console.error(`[Match Delete] 积分榜缓存更新失败: ${cacheResult.error}`);
      }
    }

    await this.auditLogService.log(
      username,
      'DELETE_MATCH',
      `删除比赛: "${match.homeTeam.teamName} vs ${match.awayTeam.teamName}"`,
    );

    return deletedMatch;
  }
}
