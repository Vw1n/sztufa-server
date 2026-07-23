import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateMatchDto,
  MatchEventPhase,
  MatchEventType,
} from './create-match.dto';

const baseMatch = {
  homeTeamId: 'home-team',
  awayTeamId: 'away-team',
  matchDate: '2026-07-23T12:00:00.000Z',
  location: '校足球场',
};

describe('CreateMatchDto event validation', () => {
  it('accepts a structured shootout event', async () => {
    const dto = plainToInstance(CreateMatchDto, {
      ...baseMatch,
      events: [
        {
          eventTime: '点1',
          eventType: MatchEventType.PenaltyShootoutGoal,
          phase: MatchEventPhase.Shootout,
          shootoutRound: 1,
          shootoutOrder: 1,
          description: '点球大战罚中',
          teamType: 'home',
          playerId: 'player-1',
        },
      ],
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an unsupported event type', async () => {
    const dto = plainToInstance(CreateMatchDto, {
      ...baseMatch,
      events: [
        {
          eventTime: "10'",
          eventType: 'free_kick_goal',
          description: '任意球',
          teamType: 'home',
        },
      ],
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'events')).toBe(true);
  });

  it('requires shootout round and order', async () => {
    const dto = plainToInstance(CreateMatchDto, {
      ...baseMatch,
      events: [
        {
          eventTime: '点',
          eventType: MatchEventType.PenaltyShootoutMiss,
          description: '点球大战罚失',
          teamType: 'away',
        },
      ],
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'events')).toBe(true);
  });
});
