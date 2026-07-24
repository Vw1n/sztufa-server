import { BadRequestException } from '@nestjs/common';
import { MatchEventPhase, MatchEventType } from './dto/create-match.dto';

type MatchEventLike = {
  eventType: string;
  teamType: string;
  phase?: string | null;
};

export interface MatchOutcome {
  homeScore: number;
  awayScore: number;
  homePenaltyScore: number | null;
  awayPenaltyScore: number | null;
  winnerTeamType: 'home' | 'away' | null;
  decidedBy: 'REGULAR' | 'EXTRA_TIME' | 'PENALTIES' | null;
}

const scoreRegularEvent = (event: MatchEventLike, score: { home: number; away: number }) => {
  if (event.eventType === MatchEventType.Goal || event.eventType === MatchEventType.Penalty) {
    if (event.teamType === 'home') score.home += 1;
    if (event.teamType === 'away') score.away += 1;
  }
  if (event.eventType === MatchEventType.OwnGoal) {
    if (event.teamType === 'home') score.away += 1;
    if (event.teamType === 'away') score.home += 1;
  }
};

export const resolveMatchOutcome = (
  homeScore: number,
  awayScore: number,
  homePenaltyScore: number | null = null,
  awayPenaltyScore: number | null = null,
  hasExtraTime = false,
): MatchOutcome => {
  if (homeScore > awayScore) {
    return {
      homeScore,
      awayScore,
      homePenaltyScore,
      awayPenaltyScore,
      winnerTeamType: 'home',
      decidedBy: hasExtraTime ? 'EXTRA_TIME' : 'REGULAR',
    };
  }
  if (awayScore > homeScore) {
    return {
      homeScore,
      awayScore,
      homePenaltyScore,
      awayPenaltyScore,
      winnerTeamType: 'away',
      decidedBy: hasExtraTime ? 'EXTRA_TIME' : 'REGULAR',
    };
  }

  if (homePenaltyScore !== null && awayPenaltyScore !== null) {
    return {
      homeScore,
      awayScore,
      homePenaltyScore,
      awayPenaltyScore,
      winnerTeamType:
        homePenaltyScore === awayPenaltyScore
          ? null
          : homePenaltyScore > awayPenaltyScore
            ? 'home'
            : 'away',
      decidedBy: homePenaltyScore === awayPenaltyScore ? null : 'PENALTIES',
    };
  }

  return {
    homeScore,
    awayScore,
    homePenaltyScore: null,
    awayPenaltyScore: null,
    winnerTeamType: null,
    decidedBy: null,
  };
};

export const calculateMatchOutcome = (events: MatchEventLike[]): MatchOutcome => {
  const regularScore = { home: 0, away: 0 };
  const penaltyScore = { home: 0, away: 0 };
  let hasShootout = false;
  let hasExtraTime = false;

  for (const event of events) {
    scoreRegularEvent(event, regularScore);
    if (event.phase === MatchEventPhase.ExtraTime) hasExtraTime = true;

    if (
      event.eventType === MatchEventType.PenaltyShootoutGoal ||
      event.eventType === MatchEventType.PenaltyShootoutMiss
    ) {
      hasShootout = true;
      if (event.eventType === MatchEventType.PenaltyShootoutGoal) {
        if (event.teamType === 'home') penaltyScore.home += 1;
        if (event.teamType === 'away') penaltyScore.away += 1;
      }
    }
  }

  if (hasShootout && regularScore.home !== regularScore.away) {
    throw new BadRequestException('常规/加时比分未打平时不能录入点球大战');
  }

  return resolveMatchOutcome(
    regularScore.home,
    regularScore.away,
    hasShootout ? penaltyScore.home : null,
    hasShootout ? penaltyScore.away : null,
    hasExtraTime,
  );
};
