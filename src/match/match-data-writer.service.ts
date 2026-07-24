import { BadRequestException, Injectable } from '@nestjs/common';
import { MatchEventPhase, MatchEventType, MatchLineupDto } from './dto/create-match.dto';

type MatchEventInput = Record<string, any>;
type GoalInput = Record<string, any>;

const isShootoutEvent = (eventType: string): boolean =>
  eventType === MatchEventType.PenaltyShootoutGoal ||
  eventType === MatchEventType.PenaltyShootoutMiss;

@Injectable()
export class MatchDataWriterService {
  async writeLineups(
    tx: any,
    matchId: string,
    homeTeamId: string,
    awayTeamId: string,
    lineups: MatchLineupDto[],
  ) {
    const uniqueLineups = Array.from(
      new Map(lineups.map((item) => [item.playerId, item])).values(),
    );
    const players = await tx.player.findMany({
      where: { id: { in: uniqueLineups.map((lineup) => lineup.playerId) } },
    });
    const playersMap = new Map(players.map((player: any) => [player.id, player]));
    const validLineups = [];

    for (const item of uniqueLineups) {
      const player: any = playersMap.get(item.playerId);
      if (!player) continue;

      const expectedTeamId = item.teamType === 'home' ? homeTeamId : awayTeamId;
      if (player.teamId !== expectedTeamId) {
        throw new BadRequestException(
          `球员 ${player.name} 队籍不属于所声明的 ${item.teamType === 'home' ? '主队' : '客队'}`,
        );
      }
      validLineups.push({
        matchId,
        playerId: item.playerId,
        teamType: item.teamType,
        lineupType: item.lineupType,
      });
    }

    if (validLineups.length > 0) {
      await tx.matchLineup.createMany({ data: validLineups });
    }
    return validLineups;
  }

  async replaceLineups(
    tx: any,
    matchId: string,
    homeTeamId: string,
    awayTeamId: string,
    lineups: MatchLineupDto[],
  ) {
    await tx.matchLineup.deleteMany({ where: { matchId } });
    if (lineups.length === 0) return [];
    return this.writeLineups(tx, matchId, homeTeamId, awayTeamId, lineups);
  }

  async writeEvents(tx: any, matchId: string, events: MatchEventInput[]) {
    if (events.length === 0) return;
    const shootoutOrders = events
      .filter((event) => isShootoutEvent(event.eventType))
      .map((event) => event.shootoutOrder);
    if (new Set(shootoutOrders).size !== shootoutOrders.length) {
      throw new BadRequestException('点球大战罚球顺序不能重复');
    }

    await tx.matchEvent.createMany({
      data: events.map((event) => ({
        matchId,
        eventTime: event.eventTime,
        eventType: event.eventType,
        phase: isShootoutEvent(event.eventType)
          ? MatchEventPhase.Shootout
          : event.phase || MatchEventPhase.Regular,
        shootoutRound: isShootoutEvent(event.eventType) ? event.shootoutRound : null,
        shootoutOrder: isShootoutEvent(event.eventType) ? event.shootoutOrder : null,
        description: event.description,
        teamType: event.teamType,
        playerId: event.playerId || null,
        playerName: event.playerName || null,
        jerseyNumber: event.jerseyNumber || null,
        subPlayerId: event.subPlayerId || null,
        subPlayerName: event.subPlayerName || null,
        subJerseyNumber: event.subJerseyNumber || null,
        assistPlayerId: event.assistPlayerId || null,
        assistPlayerName: event.assistPlayerName || null,
        assistJerseyNumber: event.assistJerseyNumber || null,
      })),
    });
  }

  async replaceEvents(tx: any, matchId: string, events: MatchEventInput[]) {
    await tx.matchEvent.deleteMany({ where: { matchId } });
    await this.writeEvents(tx, matchId, events);
  }

  async writeGoals(
    tx: any,
    matchId: string,
    events: MatchEventInput[] | undefined,
    goals: GoalInput[] | undefined,
  ) {
    const goalEvents = (events || []).filter((event) =>
      ['goal', 'penalty', 'own_goal'].includes(event.eventType),
    );
    if (goalEvents.length > 0) {
      await tx.goal.createMany({
        data: goalEvents.map((goal) => ({
          matchId,
          playerName:
            goal.eventType === 'own_goal'
              ? `${goal.playerName} (乌龙)`
              : goal.eventType === 'penalty'
                ? `${goal.playerName} (点球)`
                : goal.playerName || '',
          jerseyNumber: goal.jerseyNumber || '',
          goalTime: goal.eventTime,
          teamType:
            goal.eventType === 'own_goal'
              ? goal.teamType === 'home'
                ? 'away'
                : 'home'
              : goal.teamType,
          playerId: goal.playerId || null,
        })),
      });
      return;
    }
    if (goals && goals.length > 0) {
      await tx.goal.createMany({
        data: goals.map((goal) => ({
          matchId,
          playerName: goal.playerName,
          jerseyNumber: goal.jerseyNumber,
          goalTime: goal.goalTime,
          teamType: goal.teamType,
          playerId: goal.playerId || null,
        })),
      });
    }
  }

  async replaceGoals(
    tx: any,
    matchId: string,
    events: MatchEventInput[] | undefined,
    goals: GoalInput[] | undefined,
  ) {
    await tx.goal.deleteMany({ where: { matchId } });
    await this.writeGoals(tx, matchId, events, goals);
  }
}
