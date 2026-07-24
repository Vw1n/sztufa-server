import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 球员红黄牌与停赛状态同步服务
 * 从 MatchService 中提取，负责根据比赛事件计算球员的红黄牌数量和停赛状态
 */
@Injectable()
export class PlayerCardSyncService {
  constructor(private prisma: PrismaService) {}

  /**
   * 同步一场比赛中所有受影响球员的红黄牌状态
   */
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

  /**
   * 计算单个球员在当前活跃赛季的红黄牌数量，并判断是否需要停赛
   * 规则：
   * - 红牌/直接红牌 → 立即停赛
   * - 每累计3张黄牌 → 停赛一场
   * - 停赛后若已参加一场已结束的比赛 → 自动解禁
   */
  async syncPlayerCards(playerId: string, tx: any = this.prisma) {
    const activeSeason = await tx.season.findFirst({
      where: { status: 'active' },
    });
    const seasonWhere = activeSeason ? { seasonId: activeSeason.id } : {};

    const events = await tx.matchEvent.findMany({
      where: {
        playerId,
        eventType: { in: ['yellow_card', 'red_card', 'yellow_to_red'] },
        match: {
          ...seasonWhere,
          status: { in: ['finished', 'ongoing'] },
          deletedAt: null,
        },
      },
      include: {
        match: true,
      },
      orderBy: [{ match: { matchDate: 'asc' } }, { eventTime: 'asc' }],
    });

    const yellowEvents = events.filter((e) => e.eventType === 'yellow_card');
    const redEvents = events.filter(
      (e) => e.eventType === 'red_card' || e.eventType === 'yellow_to_red',
    );
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
            deletedAt: null,
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
