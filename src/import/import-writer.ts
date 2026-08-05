import { BadRequestException } from '@nestjs/common';
import { resolveMatchOutcome } from '../match/match-outcome';
import { JsonRecord, MatchUndoSnapshot, NormalizedMatch } from './import.types';
import { DEFAULT_LOCATION } from './import-parser';

export const DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS = 240_000;
export const MAX_IMPORT_TRANSACTION_TIMEOUT_MS = 240_000;
export const IMPORT_TRANSACTION_MAX_WAIT_MS = 15_000;

export const getImportTransactionOptions = () => {
  const configuredTimeout = Number.parseInt(process.env.IMPORT_TRANSACTION_TIMEOUT_MS || '', 10);
  const timeout =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, MAX_IMPORT_TRANSACTION_TIMEOUT_MS)
      : DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS;

  return {
    maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS,
    timeout,
  };
};

export class ImportWriter {
  static parseMatchDate(date: string, time: string | null): Date {
    const dateMatch = date.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (!dateMatch) throw new BadRequestException(`无法识别比赛日期: ${date}`);
    const timeMatch = (time || '').match(/(\d{1,2}):(\d{2})/);
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    const [, year, month, day] = dateMatch;
    return new Date(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
    );
  }

  static resolveStatus(match: NormalizedMatch): string {
    const note = `${match.time || ''} ${match.round || ''}`;
    if (match.homeScore === null || match.awayScore === null) {
      return note.includes('弃权') ? 'cancelled' : 'scheduled';
    }
    return 'finished';
  }

  static resolveCompetition(match: NormalizedMatch): {
    stage: string;
    groupName: string | null;
    knockoutRound: string | null;
  } {
    const round = match.round || '';
    const inferredGroup = match.group || round.match(/小组赛\s*([A-Z])组/i)?.[1] || null;
    if (inferredGroup || round.includes('小组')) {
      return { stage: 'GROUP', groupName: inferredGroup, knockoutRound: null };
    }
    if (/决赛|排位赛|淘汰赛|1\/4/.test(round)) {
      let knockoutRound = 'PLACEMENT';
      if (round.includes('1/4')) knockoutRound = 'QUARTER_FINAL';
      else if (round.includes('半决赛')) knockoutRound = 'SEMI_FINAL';
      else if (round === '决赛') knockoutRound = 'FINAL';
      else if (/三四名/.test(round)) knockoutRound = 'THIRD_PLACE';
      else if (/五六名/.test(round)) knockoutRound = '5TH';
      else if (/七八名/.test(round)) knockoutRound = '7TH';
      return { stage: 'KNOCKOUT', groupName: null, knockoutRound };
    }
    return { stage: 'LEAGUE', groupName: null, knockoutRound: null };
  }

  static buildMatchInput(
    match: NormalizedMatch,
    seasonId: string,
    homeTeamId: string,
    awayTeamId: string,
  ) {
    const status = this.resolveStatus(match);
    const competition = this.resolveCompetition(match);
    const matchDate = this.parseMatchDate(match.date, match.time);
    const homeScore = match.homeScore ?? 0;
    const awayScore = match.awayScore ?? 0;
    const outcome =
      status === 'finished'
        ? resolveMatchOutcome(
            homeScore,
            awayScore,
            match.homePenaltyScore,
            match.awayPenaltyScore,
          )
        : null;
    const winnerTeamId =
      outcome?.winnerTeamType === 'home'
        ? homeTeamId
        : outcome?.winnerTeamType === 'away'
          ? awayTeamId
          : null;

    return {
      match,
      homeTeamId,
      awayTeamId,
      seasonId,
      seasonName: match.seasonName,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      events: match.events,
      dbData: {
        seasonId,
        homeTeamId,
        awayTeamId,
        matchDate,
        location: DEFAULT_LOCATION,
        status,
        stage: competition.stage,
        groupName: competition.groupName,
        knockoutRound: competition.knockoutRound,
        homeScore,
        awayScore,
        homePenaltyScore: match.homePenaltyScore,
        awayPenaltyScore: match.awayPenaltyScore,
        winnerTeamId,
        decidedBy: outcome?.decidedBy ?? null,
        legacyGameId: match.legacyGameId,
      },
    };
  }

  static snapshotMatch(existing: JsonRecord, goals: JsonRecord[], events: JsonRecord[]): MatchUndoSnapshot {
    return {
      id: String(existing.id),
      data: {
        legacyGameId: existing.legacyGameId,
        homeTeamId: existing.homeTeamId,
        awayTeamId: existing.awayTeamId,
        homeScore: existing.homeScore,
        awayScore: existing.awayScore,
        homePenaltyScore: existing.homePenaltyScore,
        awayPenaltyScore: existing.awayPenaltyScore,
        winnerTeamId: existing.winnerTeamId,
        decidedBy: existing.decidedBy,
        matchDate: typeof existing.matchDate === 'object' && existing.matchDate instanceof Date
          ? existing.matchDate.toISOString()
          : String(existing.matchDate),
        location: existing.location,
        status: existing.status,
        seasonId: existing.seasonId,
        stage: existing.stage,
        groupName: existing.groupName,
        knockoutRound: existing.knockoutRound,
        deletedAt: existing.deletedAt
          ? typeof existing.deletedAt === 'object' && existing.deletedAt instanceof Date
            ? existing.deletedAt.toISOString()
            : String(existing.deletedAt)
          : null,
      },
      goals: goals.map((goal) => ({
        matchId: String(goal.matchId),
        playerId: goal.playerId ? String(goal.playerId) : null,
        playerName: String(goal.playerName || ''),
        jerseyNumber: String(goal.jerseyNumber || ''),
        goalTime: String(goal.goalTime || ''),
        teamType: String(goal.teamType),
      })),
      events: events.map((event) => ({
        matchId: String(event.matchId),
        eventTime: String(event.eventTime || ''),
        eventType: String(event.eventType),
        phase: String(event.phase || 'REGULAR'),
        shootoutRound: event.shootoutRound !== null && event.shootoutRound !== undefined ? Number(event.shootoutRound) : null,
        shootoutOrder: event.shootoutOrder !== null && event.shootoutOrder !== undefined ? Number(event.shootoutOrder) : null,
        playerId: event.playerId ? String(event.playerId) : null,
        playerName: event.playerName ? String(event.playerName) : null,
        jerseyNumber: event.jerseyNumber ? String(event.jerseyNumber) : null,
        subPlayerId: event.subPlayerId ? String(event.subPlayerId) : null,
        subPlayerName: event.subPlayerName ? String(event.subPlayerName) : null,
        subJerseyNumber: event.subJerseyNumber ? String(event.subJerseyNumber) : null,
        assistPlayerId: event.assistPlayerId ? String(event.assistPlayerId) : null,
        assistPlayerName: event.assistPlayerName ? String(event.assistPlayerName) : null,
        assistJerseyNumber: event.assistJerseyNumber ? String(event.assistJerseyNumber) : null,
        description: String(event.description ?? ''),
        teamType: String(event.teamType),
      })),
    };
  }

  static restoreMatchData(snapshotData: JsonRecord): JsonRecord {
    return {
      seasonId: snapshotData.seasonId,
      homeTeamId: snapshotData.homeTeamId,
      awayTeamId: snapshotData.awayTeamId,
      matchDate: new Date(snapshotData.matchDate as string),
      location: snapshotData.location,
      status: snapshotData.status,
      stage: snapshotData.stage,
      groupName: snapshotData.groupName,
      knockoutRound: snapshotData.knockoutRound,
      homeScore: snapshotData.homeScore,
      awayScore: snapshotData.awayScore,
      homePenaltyScore: snapshotData.homePenaltyScore,
      awayPenaltyScore: snapshotData.awayPenaltyScore,
      winnerTeamId: snapshotData.winnerTeamId,
      decidedBy: snapshotData.decidedBy,
      legacyGameId: snapshotData.legacyGameId,
      deletedAt: snapshotData.deletedAt ? new Date(snapshotData.deletedAt as string) : null,
    };
  }
}
