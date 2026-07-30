import { describe, expect, it, jest } from '@jest/globals';
import { MatchService } from './match.service';

describe('MatchService.update', () => {
  const originalMatch = {
    id: 'match-1',
    homeTeamId: 'home-old',
    awayTeamId: 'away-old',
    homeScore: 1,
    awayScore: 0,
    location: 'old-field',
    matchDate: new Date('2026-07-01T10:00:00.000Z'),
    status: 'finished',
    seasonId: 'season-1',
    deletedAt: null,
    homeTeam: { teamName: 'Home' },
    awayTeam: { teamName: 'Away' },
    events: [
      {
        playerId: 'player-old',
        subPlayerId: null,
        assistPlayerId: null,
      },
    ],
  };

  const createService = () => {
    const prisma: any = {
      match: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      team: { findUnique: jest.fn() },
      player: { findMany: jest.fn() },
      matchLineup: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      matchEvent: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      goal: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
    };
    prisma.$transaction = jest.fn((callback: (tx: typeof prisma) => unknown) => callback(prisma));

    const auditLogService: any = { log: jest.fn() };
    const playerCardSyncService: any = {
      syncMatchPlayers: jest.fn(),
      syncPlayerCards: jest.fn(),
    };
    const seasonStatistics: any = {
      computeAndCache: jest.fn(async () => ({ success: true })),
    };
    const matchQuery: any = { findDetails: jest.fn() };
    const matchDataWriter: any = {
      replaceLineups: jest.fn(),
      replaceEvents: jest.fn(),
      replaceGoals: jest.fn(),
    };

    const predictionService: any = {
      settleMatchPredictions: jest.fn(async () => ({ settledCount: 0 })),
      voidMatchPredictions: jest.fn(async () => ({ voidedCount: 0 })),
    };

    return {
      service: new MatchService(
        prisma,
        auditLogService,
        playerCardSyncService,
        seasonStatistics,
        matchQuery,
        matchDataWriter,
        predictionService,
      ),
      prisma,
      playerCardSyncService,
      seasonStatistics,
      matchQuery,
      matchDataWriter,
      predictionService,
    };
  };

  it('preserves events and goals when a partial update omits them', async () => {
    const { service, prisma, playerCardSyncService, matchQuery, matchDataWriter } = createService();
    const updatedMatch = { ...originalMatch, location: 'new-field' };
    prisma.match.findUnique
      .mockResolvedValueOnce(originalMatch)
      .mockResolvedValueOnce(updatedMatch);
    prisma.match.update.mockResolvedValue(updatedMatch);
    matchQuery.findDetails.mockResolvedValue(updatedMatch);

    await service.update('match-1', { location: 'new-field' }, 'admin');

    expect(matchDataWriter.replaceEvents).not.toHaveBeenCalled();
    expect(matchDataWriter.replaceGoals).not.toHaveBeenCalled();
    expect(playerCardSyncService.syncMatchPlayers).toHaveBeenCalledWith(
      'match-1',
      'home-old',
      'away-old',
      'finished',
      originalMatch.events,
      prisma,
    );
  });

  it('preserves an imported score when the editor submits an empty event list', async () => {
    const { service, prisma, matchQuery } = createService();
    const importedMatch = {
      ...originalMatch,
      homeScore: 3,
      awayScore: 2,
      events: [],
    };
    prisma.match.findUnique
      .mockResolvedValueOnce(importedMatch)
      .mockResolvedValueOnce(importedMatch);
    prisma.match.update.mockResolvedValue(importedMatch);
    matchQuery.findDetails.mockResolvedValue(importedMatch);

    await service.update('match-1', { homeScore: 3, awayScore: 2, events: [] }, 'admin');

    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ homeScore: 3, awayScore: 2 }),
      }),
    );
  });

  it('preserves an aggregate imported shootout score when regular events are edited', async () => {
    const { service, prisma, matchQuery } = createService();
    const regularEvents = [
      { eventType: 'goal', teamType: 'home', playerId: 'home-1' },
      { eventType: 'goal', teamType: 'home', playerId: 'home-2' },
      { eventType: 'goal', teamType: 'away', playerId: 'away-1' },
      { eventType: 'goal', teamType: 'away', playerId: 'away-2' },
    ];
    const importedFinal = {
      ...originalMatch,
      homeScore: 2,
      awayScore: 2,
      homePenaltyScore: 4,
      awayPenaltyScore: 5,
      events: regularEvents,
    };
    prisma.match.findUnique
      .mockResolvedValueOnce(importedFinal)
      .mockResolvedValueOnce(importedFinal);
    prisma.match.update.mockResolvedValue(importedFinal);
    matchQuery.findDetails.mockResolvedValue(importedFinal);

    await service.update(
      'match-1',
      { homeScore: 2, awayScore: 2, events: regularEvents as any },
      'admin',
    );

    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          homeScore: 2,
          awayScore: 2,
          homePenaltyScore: 4,
          awayPenaltyScore: 5,
          decidedBy: 'PENALTIES',
        }),
      }),
    );
  });

  it('validates replacement lineups against the new teams', async () => {
    const { service, prisma, matchQuery, matchDataWriter } = createService();
    const updatedMatch = {
      ...originalMatch,
      homeTeamId: 'home-new',
      awayTeamId: 'away-new',
    };
    prisma.match.findUnique
      .mockResolvedValueOnce(originalMatch)
      .mockResolvedValueOnce(updatedMatch);
    prisma.match.update.mockResolvedValue(updatedMatch);
    matchQuery.findDetails.mockResolvedValue(updatedMatch);
    prisma.team.findUnique
      .mockResolvedValueOnce({ id: 'home-new' })
      .mockResolvedValueOnce({ id: 'away-new' });
    prisma.player.findMany.mockResolvedValue([
      { id: 'home-player', name: 'Home player', teamId: 'home-new' },
      { id: 'away-player', name: 'Away player', teamId: 'away-new' },
    ]);

    await service.update(
      'match-1',
      {
        homeTeamId: 'home-new',
        awayTeamId: 'away-new',
        lineups: [
          { playerId: 'home-player', teamType: 'home', lineupType: 'starting' },
          { playerId: 'away-player', teamType: 'away', lineupType: 'starting' },
        ],
      },
      'admin',
    );

    expect(matchDataWriter.replaceLineups).toHaveBeenCalledWith(
      prisma,
      'match-1',
      'home-new',
      'away-new',
      expect.arrayContaining([
        { playerId: 'home-player', teamType: 'home', lineupType: 'starting' },
        { playerId: 'away-player', teamType: 'away', lineupType: 'starting' },
      ]),
    );
  });

  it('rolls back transaction if prediction settlement fails during match update', async () => {
    const { service, prisma, predictionService } = createService();
    prisma.match.findUnique.mockResolvedValue(originalMatch);
    predictionService.settleMatchPredictions.mockRejectedValue(new Error('Settlement DB Error'));

    await expect(service.update('match-1', { status: 'finished' }, 'admin')).rejects.toThrow(
      'Settlement DB Error',
    );
  });
});
