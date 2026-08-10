import { Logger } from '@nestjs/common';

export type MatchLike = {
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  homePenaltyScore?: number | null;
  awayPenaltyScore?: number | null;
  winnerTeamId?: string | null;
  events?: Array<{
    eventType?: string;
    teamType?: string;
  }> | null;
};

const logger = new Logger('WinnerTeamIdResolver');

export const isHistoricalSeasonTeamIdMatch = (
  id1: string | null | undefined,
  id2: string | null | undefined,
): boolean => {
  if (!id1 || !id2) return false;
  if (id1 === id2) return true;
  const match1 = id1.match(/^(.+)_season_[A-Za-z0-9]+$/);
  const match2 = id2.match(/^(.+)_season_[A-Za-z0-9]+$/);
  // 两个均带赛季后缀且完整 ID 不全等，判定为不匹配
  if (match1 && match2) return false;
  const base1 = match1 ? match1[1] : id1;
  const base2 = match2 ? match2[1] : id2;
  return base1 === base2;
};

export const getCanonicalWinnerTeamId = (match: MatchLike): string | null => {
  const homeTeamId = match.homeTeamId;
  const awayTeamId = match.awayTeamId;

  if (!homeTeamId || !awayTeamId) return null;

  // 优先级 1：常规/加时比分直接决胜
  if (
    typeof match.homeScore === 'number' &&
    typeof match.awayScore === 'number' &&
    match.homeScore !== match.awayScore
  ) {
    const winner = match.homeScore > match.awayScore ? homeTeamId : awayTeamId;
    if (
      match.winnerTeamId &&
      match.winnerTeamId !== winner &&
      !isHistoricalSeasonTeamIdMatch(match.winnerTeamId, winner)
    ) {
      logger.warn(
        `[WinnerResolution] Match score winner (${winner}) overrides conflicting stored winnerTeamId (${match.winnerTeamId})`,
      );
    }
    return winner;
  }

  // 优先级 2：结构化点球比分决胜
  if (
    match.homePenaltyScore !== null &&
    match.homePenaltyScore !== undefined &&
    match.awayPenaltyScore !== null &&
    match.awayPenaltyScore !== undefined &&
    match.homePenaltyScore !== match.awayPenaltyScore
  ) {
    const winner = match.homePenaltyScore > match.awayPenaltyScore ? homeTeamId : awayTeamId;
    if (
      match.winnerTeamId &&
      match.winnerTeamId !== winner &&
      !isHistoricalSeasonTeamIdMatch(match.winnerTeamId, winner)
    ) {
      logger.warn(
        `[WinnerResolution] Match penalty score winner (${winner}) overrides conflicting stored winnerTeamId (${match.winnerTeamId})`,
      );
    }
    return winner;
  }

  // 优先级 3：点球事件决胜
  if (Array.isArray(match.events) && match.events.length > 0) {
    let homeShootout = 0;
    let awayShootout = 0;
    let hasShootoutEvent = false;

    for (const event of match.events) {
      if (event.eventType === 'penalty_shootout_goal') {
        hasShootoutEvent = true;
        if (event.teamType === 'home') homeShootout += 1;
        if (event.teamType === 'away') awayShootout += 1;
      } else if (event.eventType === 'penalty_shootout_miss') {
        hasShootoutEvent = true;
      }
    }

    if (hasShootoutEvent && homeShootout !== awayShootout) {
      const winner = homeShootout > awayShootout ? homeTeamId : awayTeamId;
      if (
        match.winnerTeamId &&
        match.winnerTeamId !== winner &&
        !isHistoricalSeasonTeamIdMatch(match.winnerTeamId, winner)
      ) {
        logger.warn(
          `[WinnerResolution] Match penalty events winner (${winner}) overrides conflicting stored winnerTeamId (${match.winnerTeamId})`,
        );
      }
      return winner;
    }
  }

  // 优先级 4：仅当 1~3 无法决胜时（例如比分/事件未录入），才使用 winnerTeamId 规范映射
  if (match.winnerTeamId) {
    const matchesHome = isHistoricalSeasonTeamIdMatch(match.winnerTeamId, homeTeamId);
    const matchesAway = isHistoricalSeasonTeamIdMatch(match.winnerTeamId, awayTeamId);

    if (matchesHome && !matchesAway) return homeTeamId;
    if (matchesAway && !matchesHome) return awayTeamId;
  }

  // 优先级 5：平局且无法决胜或矛盾
  return null;
};
