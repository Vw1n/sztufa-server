export type KnockoutMigrationEvent = {
  eventType: string;
  teamType: string;
};

export type KnockoutMigrationMatch = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePenaltyScore?: number | null;
  awayPenaltyScore?: number | null;
  winnerTeamId?: string | null;
  matchDate: Date;
  status: string;
  stage?: string | null;
  knockoutRound?: string | null;
  knockoutMatchIndex?: number | null;
  deletedAt?: Date | null;
  events?: KnockoutMigrationEvent[];
};

const getPenaltyScoreFromEvents = (
  events: KnockoutMigrationEvent[] = [],
): { home: number; away: number } | null => {
  const shootoutEvents = events.filter(
    (event) =>
      event.eventType === 'penalty_shootout_goal' || event.eventType === 'penalty_shootout_miss',
  );
  if (shootoutEvents.length === 0) return null;

  return shootoutEvents.reduce(
    (score, event) => {
      if (event.eventType === 'penalty_shootout_goal') {
        if (event.teamType === 'home') score.home += 1;
        if (event.teamType === 'away') score.away += 1;
      }
      return score;
    },
    { home: 0, away: 0 },
  );
};

export const getKnockoutWinnerTeamId = (match: KnockoutMigrationMatch): string | null => {
  if (match.winnerTeamId === match.homeTeamId || match.winnerTeamId === match.awayTeamId) {
    return match.winnerTeamId;
  }
  if (match.homeScore > match.awayScore) return match.homeTeamId;
  if (match.awayScore > match.homeScore) return match.awayTeamId;

  const penaltyScore =
    match.homePenaltyScore !== null &&
    match.homePenaltyScore !== undefined &&
    match.awayPenaltyScore !== null &&
    match.awayPenaltyScore !== undefined
      ? { home: match.homePenaltyScore, away: match.awayPenaltyScore }
      : getPenaltyScoreFromEvents(match.events);

  if (!penaltyScore || penaltyScore.home === penaltyScore.away) return null;
  return penaltyScore.home > penaltyScore.away ? match.homeTeamId : match.awayTeamId;
};

export const findThirdPlaceMatch = (
  matches: KnockoutMigrationMatch[],
): KnockoutMigrationMatch | null => {
  const semifinals = matches
    .filter(
      (match) =>
        match.deletedAt == null &&
        match.status === 'finished' &&
        match.stage === 'KNOCKOUT' &&
        match.knockoutRound === 'SF',
    )
    .sort(
      (first, second) =>
        Number(first.knockoutMatchIndex || 0) - Number(second.knockoutMatchIndex || 0),
    );
  const semifinalOne = semifinals.find((match) => Number(match.knockoutMatchIndex) === 1);
  const semifinalTwo = semifinals.find((match) => Number(match.knockoutMatchIndex) === 2);
  if (!semifinalOne || !semifinalTwo) return null;

  const loserOf = (match: KnockoutMigrationMatch): string | null => {
    const winnerTeamId = getKnockoutWinnerTeamId(match);
    if (winnerTeamId === match.homeTeamId) return match.awayTeamId;
    if (winnerTeamId === match.awayTeamId) return match.homeTeamId;
    return null;
  };
  const firstLoser = loserOf(semifinalOne);
  const secondLoser = loserOf(semifinalTwo);
  if (!firstLoser || !secondLoser) return null;

  const semifinalEnd = Math.max(semifinalOne.matchDate.getTime(), semifinalTwo.matchDate.getTime());
  return (
    matches
      .filter(
        (match) =>
          match.deletedAt == null &&
          match.stage !== 'GROUP' &&
          match.knockoutRound !== 'SF' &&
          match.knockoutRound !== 'F' &&
          match.matchDate.getTime() >= semifinalEnd &&
          ((match.homeTeamId === firstLoser && match.awayTeamId === secondLoser) ||
            (match.homeTeamId === secondLoser && match.awayTeamId === firstLoser)),
      )
      .sort((first, second) => first.matchDate.getTime() - second.matchDate.getTime())[0] || null
  );
};
