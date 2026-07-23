import { BadRequestException } from '@nestjs/common';
import { calculateMatchOutcome } from './match-outcome';

describe('calculateMatchOutcome', () => {
  it('counts regular goals, penalties and own goals only', () => {
    const outcome = calculateMatchOutcome([
      { eventType: 'goal', teamType: 'home' },
      { eventType: 'penalty', teamType: 'away' },
      { eventType: 'penalty_miss', teamType: 'home' },
      { eventType: 'own_goal', teamType: 'away' },
    ]);

    expect(outcome).toEqual({
      homeScore: 2,
      awayScore: 1,
      homePenaltyScore: null,
      awayPenaltyScore: null,
      winnerTeamType: 'home',
      decidedBy: 'REGULAR',
    });
  });

  it('keeps the full-time score level and resolves a shootout winner', () => {
    const outcome = calculateMatchOutcome([
      { eventType: 'goal', teamType: 'home' },
      { eventType: 'goal', teamType: 'away' },
      { eventType: 'penalty_shootout_goal', teamType: 'home', phase: 'SHOOTOUT' },
      { eventType: 'penalty_shootout_goal', teamType: 'away', phase: 'SHOOTOUT' },
      { eventType: 'penalty_shootout_goal', teamType: 'home', phase: 'SHOOTOUT' },
      { eventType: 'penalty_shootout_miss', teamType: 'away', phase: 'SHOOTOUT' },
    ]);

    expect(outcome).toEqual({
      homeScore: 1,
      awayScore: 1,
      homePenaltyScore: 2,
      awayPenaltyScore: 1,
      winnerTeamType: 'home',
      decidedBy: 'PENALTIES',
    });
  });

  it('rejects a shootout when the full-time score is not level', () => {
    expect(() =>
      calculateMatchOutcome([
        { eventType: 'goal', teamType: 'home' },
        { eventType: 'penalty_shootout_goal', teamType: 'away', phase: 'SHOOTOUT' },
      ]),
    ).toThrow(BadRequestException);
  });
});
