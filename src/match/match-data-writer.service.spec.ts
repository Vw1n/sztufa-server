import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { MatchDataWriterService } from './match-data-writer.service';

describe('MatchDataWriterService', () => {
  it('deduplicates lineups and validates team ownership', async () => {
    const tx: any = {
      player: {
        findMany: jest
          .fn<() => Promise<any[]>>()
          .mockResolvedValue([{ id: 'player-1', name: 'Player', teamId: 'home-team' }]),
      },
      matchLineup: { createMany: jest.fn() },
    };
    const service = new MatchDataWriterService();

    await service.writeLineups(tx, 'match-1', 'home-team', 'away-team', [
      { playerId: 'player-1', teamType: 'home', lineupType: 'starting' },
      { playerId: 'player-1', teamType: 'home', lineupType: 'substitute' },
    ]);

    expect(tx.matchLineup.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ playerId: 'player-1', lineupType: 'substitute' })],
    });
  });

  it('rejects a player assigned to the wrong team', async () => {
    const tx: any = {
      player: {
        findMany: jest
          .fn<() => Promise<any[]>>()
          .mockResolvedValue([{ id: 'player-1', name: 'Player', teamId: 'away-team' }]),
      },
      matchLineup: { createMany: jest.fn() },
    };
    const service = new MatchDataWriterService();

    await expect(
      service.writeLineups(tx, 'match-1', 'home-team', 'away-team', [
        { playerId: 'player-1', teamType: 'home', lineupType: 'starting' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prefers event goals and converts own-goal ownership', async () => {
    const tx: any = { goal: { createMany: jest.fn() } };
    const service = new MatchDataWriterService();

    await service.writeGoals(
      tx,
      'match-1',
      [
        {
          eventType: 'own_goal',
          playerName: 'Player',
          teamType: 'home',
          eventTime: '10',
        },
      ],
      [{ playerName: 'Legacy goal' }],
    );

    expect(tx.goal.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ playerName: 'Player (乌龙)', teamType: 'away' })],
    });
  });

  it('stores structured shootout fields without creating a regular goal', async () => {
    const tx: any = {
      matchEvent: { createMany: jest.fn() },
      goal: { createMany: jest.fn() },
    };
    const service = new MatchDataWriterService();
    const events = [
      {
        eventTime: '点1',
        eventType: 'penalty_shootout_goal',
        description: '点球大战罚中',
        teamType: 'home',
        shootoutRound: 1,
        shootoutOrder: 1,
      },
    ];

    await service.writeEvents(tx, 'match-1', events);
    await service.writeGoals(tx, 'match-1', events, undefined);

    expect(tx.matchEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          phase: 'SHOOTOUT',
          shootoutRound: 1,
          shootoutOrder: 1,
        }),
      ],
    });
    expect(tx.goal.createMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate shootout order values', async () => {
    const tx: any = { matchEvent: { createMany: jest.fn() } };
    const service = new MatchDataWriterService();
    const events = [1, 2].map((round) => ({
      eventTime: `点${round}`,
      eventType: 'penalty_shootout_goal',
      description: '点球大战罚中',
      teamType: round === 1 ? 'home' : 'away',
      shootoutRound: round,
      shootoutOrder: 1,
    }));

    await expect(service.writeEvents(tx, 'match-1', events)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
