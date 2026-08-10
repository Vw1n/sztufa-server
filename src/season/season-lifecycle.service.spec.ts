import { describe, expect, it, jest } from '@jest/globals';
import { SeasonLifecycleService } from './season-lifecycle.service';

describe('SeasonLifecycleService', () => {
  const createService = () => {
    const tx: any = {
      season: {
        create: jest.fn(async () => ({
          id: 'season-new',
          name: '2027校长杯',
          status: 'active',
          type: 'CUP',
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      player: {
        updateMany: jest.fn(async () => ({ count: 10 })),
      },
      seasonTeamPlayer: {
        createMany: jest.fn(),
      },
    };
    const prisma: any = {
      season: {
        findUnique: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
    };
    const auditLogService: any = { log: jest.fn(async () => undefined) };
    const seasonStatistics: any = { computeAndCache: jest.fn(async () => ({ success: true })) };
    return {
      service: new SeasonLifecycleService(prisma, auditLogService, seasonStatistics),
      tx,
      auditLogService,
    };
  };

  it('creates a season with an empty roster instead of inheriting historical players', async () => {
    const { service, tx, auditLogService } = createService();

    await expect(service.createSeason(' 2027校长杯 ', 'CUP', 'admin')).resolves.toEqual(
      expect.objectContaining({ id: 'season-new' }),
    );

    expect(tx.seasonTeamPlayer.createMany).not.toHaveBeenCalled();
    expect(tx.player.updateMany).toHaveBeenCalled();
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin',
      'CREATE_SEASON',
      expect.stringContaining('新赛季名单为空'),
    );
  });

  it('archives the previous season without inheriting its teams into the new roster', async () => {
    const { service, tx, auditLogService } = createService();

    await expect(service.archiveAndCreateNewSeason('2027校长杯', 'CUP', 'admin')).resolves.toEqual(
      expect.objectContaining({ id: 'season-new' }),
    );

    expect(tx.season.updateMany).toHaveBeenCalledWith({
      where: { status: 'active' },
      data: { status: 'archived' },
    });
    expect(tx.seasonTeamPlayer.createMany).not.toHaveBeenCalled();
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin',
      'ARCHIVE_SEASON',
      expect.stringContaining('新赛季名单为空'),
    );
  });

  describe('cleanStaleManualChampion', () => {
    it('clears manual champion when team is no longer in valid LEAGUE champion candidates', async () => {
      const season = { id: 's-1', name: '2026 男子组', manualChampionTeamId: 'team-1' };
      const prisma: any = {
        season: {
          findUnique: (jest.fn() as any).mockResolvedValue(season),
          update: (jest.fn() as any).mockResolvedValue({}),
        },
        seasonTeamPlayer: { findMany: (jest.fn() as any).mockResolvedValue([]) },
        match: { findMany: (jest.fn() as any).mockResolvedValue([]) },
      };
      const service = new SeasonLifecycleService(prisma, {} as any, {} as any);

      await service.cleanStaleManualChampion('s-1');

      expect(prisma.season.update).toHaveBeenCalledWith({
        where: { id: 's-1' },
        data: {
          manualChampionTeamId: null,
          manualChampionSetBy: null,
          manualChampionSetAt: null,
        },
      });
      // Assert that match query uses AND with stageFilter
      expect(prisma.match.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [{ OR: [{ stage: 'LEAGUE' }, { stage: null }] }],
          }),
        }),
      );
    });

    it('retains manual champion when team is in finished LEAGUE match', async () => {
      const season = { id: 's-1', name: '2026 男子组', manualChampionTeamId: 'team-1' };
      const prisma: any = {
        season: {
          findUnique: (jest.fn() as any).mockResolvedValue(season),
          update: jest.fn(),
        },
        seasonTeamPlayer: { findMany: (jest.fn() as any).mockResolvedValue([]) },
        match: {
          findMany: (jest.fn() as any).mockResolvedValue([
            {
              homeTeamId: 'team-1',
              awayTeamId: 'team-2',
              homeTeam: { gender: 'MALE' },
              awayTeam: { gender: 'MALE' },
              stage: 'LEAGUE',
              status: 'finished',
            },
          ]),
        },
      };
      const service = new SeasonLifecycleService(prisma, {} as any, {} as any);

      await service.cleanStaleManualChampion('s-1');

      expect(prisma.season.update).not.toHaveBeenCalled();
    });

    it('filters out female teams for ungendered season name (defaults to MALE), aligning 100% with SeasonStatisticsService', async () => {
      const season = { id: 's-1', name: '2026 校长杯联赛', manualChampionTeamId: 'team-female' };
      const prisma: any = {
        season: {
          findUnique: (jest.fn() as any).mockResolvedValue(season),
          update: (jest.fn() as any).mockResolvedValue({}),
        },
        seasonTeamPlayer: {
          findMany: (jest.fn() as any).mockResolvedValue([
            {
              teamId: 'team-female',
              team: { gender: 'FEMALE' },
            },
          ]),
        },
        match: { findMany: (jest.fn() as any).mockResolvedValue([]) },
      };
      const service = new SeasonLifecycleService(prisma, {} as any, {} as any);

      const validTeamIds = await service.getSeasonValidChampionTeamIds('s-1');
      expect(validTeamIds.has('team-female')).toBe(false);

      await service.cleanStaleManualChampion('s-1');
      expect(prisma.season.update).toHaveBeenCalledWith({
        where: { id: 's-1' },
        data: {
          manualChampionTeamId: null,
          manualChampionSetBy: null,
          manualChampionSetAt: null,
        },
      });
    });
  });
});
