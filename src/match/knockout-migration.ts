import { getCanonicalWinnerTeamId } from './winner-team-id';

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

export const getKnockoutWinnerTeamId = (match: KnockoutMigrationMatch): string | null => {
  return getCanonicalWinnerTeamId(match);
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
