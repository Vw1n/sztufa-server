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
  hasOutcomeEvents,
  hasShootoutEvents,
  resolveMatchOutcome,
} from './match-outcome';

import { PredictionService } from '../prediction/prediction.service';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly playerCardSyncService: PlayerCardSyncService,
    private readonly seasonStatistics: SeasonStatisticsService,
    private readonly matchQuery: MatchQueryService,
    private readonly matchDataWriter: MatchDataWriterService,
    private readonly predictionService: PredictionService,
  ) {}

  async createMatchCore(tx: any, createMatchDto: CreateMatchDto, username: string) {
    if (createMatchDto.homeTeamId === createMatchDto.awayTeamId) {
      throw new BadRequestException('主队和客队不能是同一支球队');
    }

    const [homeTeam, awayTeam] = await Promise.all([
      tx.team.findUnique({ where: { id: createMatchDto.homeTeamId } }),
      tx.team.findUnique({ where: { id: createMatchDto.awayTeamId } }),
    ]);

    if (!homeTeam) {
      throw new NotFoundException('主队不存在');
    }
    if (!awayTeam) {
      throw new NotFoundException('客队不存在');
    }

    let seasonId = createMatchDto.seasonId;
    if (!seasonId) {
      const activeSeason = await tx.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      seasonId = activeSeason ? activeSeason.id : undefined;
    }

    if (seasonId) {
      const [homeProfile, awayProfile] = await Promise.all([
        tx.seasonTeamProfile.findUnique({
          where: { seasonId_teamId: { seasonId, teamId: createMatchDto.homeTeamId! } },
        }),
        tx.seasonTeamProfile.findUnique({
          where: { seasonId_teamId: { seasonId, teamId: createMatchDto.awayTeamId! } },
        }),
      ]);
      if (!homeProfile) {
        throw new BadRequestException('主队在所选赛季中未登记或不存在');
      }
      if (!awayProfile) {
        throw new BadRequestException('客队在所选赛季中未登记或不存在');
      }
    }

    const { goals, events, lineups, ...matchData } = createMatchDto;
    delete (matchData as any).seasonId;
    const outcome =
      events && hasOutcomeEvents(events)
        ? calculateMatchOutcome(
            events,
            createMatchDto.homePenaltyScore ?? null,
            createMatchDto.awayPenaltyScore ?? null,
          )
        : resolveMatchOutcome(
            matchData.homeScore || 0,
            matchData.awayScore || 0,
            createMatchDto.homePenaltyScore ?? null,
            createMatchDto.awayPenaltyScore ?? null,
          );
    const winnerTeamId =
      outcome.winnerTeamType === 'home'
        ? createMatchDto.homeTeamId
        : outcome.winnerTeamType === 'away'
          ? createMatchDto.awayTeamId
          : null;

    const createdMatch = await tx.match.create({
      data: {
        ...matchData,
        homeTeamId: createMatchDto.homeTeamId!,
        awayTeamId: createMatchDto.awayTeamId!,
        matchDate: createMatchDto.matchDate ? new Date(createMatchDto.matchDate) : new Date(),
        location: createMatchDto.location || '',
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

    return { match: createdMatch, validLineups: validatedLineups, events: events || [] };
  }

  async afterMatchCommitted(matchId: string, username: string, events: any[] = []) {
    try {
      const match = await this.prisma.match.findUnique({
        where: { id: matchId },
        include: { homeTeam: true, awayTeam: true },
      });
      if (!match) return;

      if (match.status === 'finished') {
        await this.predictionService.settleMatchPredictions(match.id, this.prisma);
      }

      await this.playerCardSyncService.syncMatchPlayers(
        match.id,
        match.homeTeamId,
        match.awayTeamId,
        match.status,
        events,
        this.prisma,
      );

      await this.auditLogService.log(
        username,
        'CREATE_MATCH',
        `录入比赛: "${match.homeTeam?.teamName || ''} vs ${match.awayTeam?.teamName || ''}" (比分: ${match.homeScore}:${match.awayScore})`,
      );

      if (match.seasonId) {
        await this.seasonStatistics.computeAndCache(match.seasonId);
      }
    } catch (err) {
      console.error(`[afterMatchCommitted Error] Failed for match ${matchId}:`, err);
    }
  }

  async create(createMatchDto: CreateMatchDto, username: string, txParam?: any) {
    if (txParam) {
      const res = await this.createMatchCore(txParam, createMatchDto, username);
      return res.match;
    }

    const result = await this.prisma.$transaction(async (innerTx) => {
      return this.createMatchCore(innerTx, createMatchDto, username);
    });

    await this.afterMatchCommitted(result.match.id, username, result.events);
    return this.matchQuery.findDetails(result.match.id);
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

  async updateMatchCore(tx: any, id: string, updateMatchDto: UpdateMatchDto, username: string) {
    const match = await tx.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    const seasonId = updateMatchDto.seasonId || match.seasonId;
    const finalHomeTeamId = updateMatchDto.homeTeamId || match.homeTeamId;
    const finalAwayTeamId = updateMatchDto.awayTeamId || match.awayTeamId;
    if (finalHomeTeamId === finalAwayTeamId) {
      throw new BadRequestException('主队和客队不能是同一支球队');
    }

    if (tx.seasonTeamProfile?.findUnique) {
      const [homeProfile, awayProfile] = await Promise.all([
        tx.seasonTeamProfile.findUnique({
          where: { seasonId_teamId: { seasonId, teamId: finalHomeTeamId } },
        }),
        tx.seasonTeamProfile.findUnique({
          where: { seasonId_teamId: { seasonId, teamId: finalAwayTeamId } },
        }),
      ]);

      if (!homeProfile) {
        throw new BadRequestException(`主队 (${finalHomeTeamId}) 在比赛赛季中未建立报名档案`);
      }
      if (!awayProfile) {
        throw new BadRequestException(`客队 (${finalAwayTeamId}) 在比赛赛季中未建立报名档案`);
      }
    }

    const { goals, events, lineups, ...matchData } = updateMatchDto;
    const preserveStoredPenalty = events === undefined || !hasShootoutEvents(match.events);
    const homePenaltyScore =
      updateMatchDto.homePenaltyScore !== undefined
        ? updateMatchDto.homePenaltyScore
        : preserveStoredPenalty
          ? match.homePenaltyScore
          : null;
    const awayPenaltyScore =
      updateMatchDto.awayPenaltyScore !== undefined
        ? updateMatchDto.awayPenaltyScore
        : preserveStoredPenalty
          ? match.awayPenaltyScore
          : null;
    const outcome =
      events && hasOutcomeEvents(events)
        ? calculateMatchOutcome(events, homePenaltyScore, awayPenaltyScore)
        : resolveMatchOutcome(
            updateMatchDto.homeScore ?? match.homeScore,
            updateMatchDto.awayScore ?? match.awayScore,
            homePenaltyScore,
            awayPenaltyScore,
          );
    const winnerTeamId =
      outcome.winnerTeamType === 'home'
        ? finalHomeTeamId
        : outcome.winnerTeamType === 'away'
          ? finalAwayTeamId
          : null;

    await tx.match.update({
      where: { id },
      data: {
        ...matchData,
        seasonId,
        homeTeamId: finalHomeTeamId,
        awayTeamId: finalAwayTeamId,
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

    const curMatch = await tx.match.findUnique({ where: { id } });
    if (curMatch && curMatch.status === 'finished') {
      await this.predictionService.settleMatchPredictions(id, tx);
    } else if (curMatch && (curMatch.status === 'cancelled' || curMatch.status === 'void')) {
      await this.predictionService.voidMatchPredictions(id, username, tx);
    }

    return { match: curMatch, oldMatch: match, events: events ?? match.events };
  }

  async update(id: string, updateMatchDto: UpdateMatchDto, username: string, txParam?: any) {
    if (txParam) {
      const res = await this.updateMatchCore(txParam, id, updateMatchDto, username);
      return res.match;
    }

    const txResult = await this.prisma.$transaction(
      async (tx) => this.updateMatchCore(tx, id, updateMatchDto, username),
      { timeout: 30000 },
    );

    if (!txResult?.match) {
      throw new NotFoundException('同步更新比赛时失败，未找到该场比赛信息');
    }

    const updatedMatch = txResult.match;
    const match = txResult.oldMatch;
    const events = txResult.events;
    const { lineups } = updateMatchDto;

    // 重新计算并同步所有受影响球员和需解禁停赛球员的状态
    const effectiveEvents = events;
    await this.playerCardSyncService.syncMatchPlayers(
      id,
      updatedMatch.homeTeamId,
      updatedMatch.awayTeamId,
      updatedMatch.status,
      effectiveEvents,
      this.prisma,
    );

    if (updateMatchDto.events !== undefined) {
      const currentPlayerIds = new Set(
        effectiveEvents.flatMap((event: any) =>
          [event.playerId, event.subPlayerId, event.assistPlayerId].filter(Boolean),
        ),
      );
      const previousPlayerIds = new Set(
        match.events.flatMap((event: any) =>
          [event.playerId, event.subPlayerId, event.assistPlayerId].filter(Boolean),
        ),
      );
      for (const playerId of previousPlayerIds) {
        if (!currentPlayerIds.has(playerId)) {
          await this.playerCardSyncService.syncPlayerCards(String(playerId), this.prisma);
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
    if (updateMatchDto.events !== undefined) {
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

    const queryResult = await this.matchQuery.findDetails(id);

    if (queryResult && queryResult.seasonId) {
      const cacheResult = await this.seasonStatistics.computeAndCache(queryResult.seasonId);
      if (!cacheResult.success) {
        console.error(`[Match Update] 积分榜缓存更新失败: ${cacheResult.error}`);
      }
    }

    return queryResult;
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

    // 软删除比赛与作废竞猜在同一事务中处理
    const deletedMatch = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.match.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.predictionService.voidMatchPredictions(id, username, tx);
      return deleted;
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
