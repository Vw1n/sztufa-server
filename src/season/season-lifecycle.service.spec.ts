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
    return {
      service: new SeasonLifecycleService(prisma, auditLogService),
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
});
