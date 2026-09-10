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
        update: jest.fn(async () => ({
          id: 'season-old',
          name: '2026超级杯',
          status: 'active',
        })),
        findMany: jest.fn(async () => [{ id: 'season-old' }]),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => ({
          id: 'season-old',
          name: '2026超级杯',
          status: 'archived',
        })),
      },
      player: {
        updateMany: jest.fn(async () => ({ count: 10 })),
      },
      seasonTeamPlayer: {
        createMany: jest.fn(),
      },
      backupRun: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => ({})),
      },
    };
    const prisma: any = {
      season: {
        findUnique: jest.fn(async (query: any) => {
          if (query.where?.name) {
            return null;
          }
          return {
            id: query.where?.id || 'season-old',
            name: '2026超级杯',
            status: 'active',
          };
        }),
        findMany: jest.fn(async () => [{ id: 'season-old' }]),
      },
      $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
    };
    const auditLogService: any = { log: jest.fn(async () => undefined) };
    const backupService: any = {
      createArchiveSeasonBackup: jest.fn(async () => undefined),
      executePendingArchiveBackup: jest.fn(async () => ({
        seasonId: 'season-old',
        status: 'succeeded',
      })),
    };
    return {
      service: new SeasonLifecycleService(prisma, auditLogService, backupService),
      prisma,
      tx,
      auditLogService,
      backupService,
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

  it('archives the previous season, atomically registers pending BackupRun, and executes archive backup', async () => {
    const { service, tx, auditLogService, backupService } = createService();

    await expect(service.archiveAndCreateNewSeason('2027校长杯', 'CUP', 'admin')).resolves.toEqual(
      expect.objectContaining({ id: 'season-new' }),
    );

    expect(tx.season.updateMany).toHaveBeenCalledWith({
      where: { id: 'season-old', status: 'active' },
      data: { status: 'archived', archivedAt: expect.any(Date) },
    });
    expect(tx.backupRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskKey: 'archive:season:season-old' },
        create: expect.objectContaining({
          taskKey: 'archive:season:season-old',
          status: 'pending',
          trigger: 'archive',
          purpose: 'archive',
        }),
      }),
    );
    expect(backupService.executePendingArchiveBackup).toHaveBeenCalledWith('season-old', 'admin');
    expect(tx.seasonTeamPlayer.createMany).not.toHaveBeenCalled();
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin',
      'ARCHIVE_SEASON',
      expect.stringContaining('新赛季名单为空'),
    );
  });

  it('updates season status to archived, registers BackupRun, and triggers executePendingArchiveBackup', async () => {
    const { service, tx, backupService } = createService();

    await service.updateSeasonStatus('season-old', 'archived', 'admin');

    expect(tx.season.updateMany).toHaveBeenCalledWith({
      where: { id: 'season-old', status: 'active' },
      data: { status: 'archived', archivedAt: expect.any(Date) },
    });
    expect(tx.backupRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskKey: 'archive:season:season-old' },
        create: expect.objectContaining({
          status: 'pending',
          purpose: 'archive',
        }),
      }),
    );
    expect(backupService.executePendingArchiveBackup).toHaveBeenCalledWith('season-old', 'admin');
  });

  it('handles race condition when active seasons change before or during transaction', async () => {
    const { service, tx, backupService } = createService();
    // 模拟事务内查出的活跃赛季已被其他并发请求修改，updateMany 返回 count: 0
    tx.season.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.archiveAndCreateNewSeason('2027校长杯', 'CUP', 'admin');

    // 由于没有赛季被当前事务实际由 active 转换为 archived，因此不能登记任务也不能触发备份
    expect(tx.backupRun.upsert).not.toHaveBeenCalled();
    expect(backupService.executePendingArchiveBackup).not.toHaveBeenCalled();
  });

  it('updates season status to active without triggering archive backup', async () => {
    const { service, tx, backupService } = createService();

    await service.updateSeasonStatus('season-old', 'active', 'admin');

    expect(tx.season.update).toHaveBeenCalledWith({
      where: { id: 'season-old' },
      data: { status: 'active' },
    });
    expect(tx.backupRun.upsert).not.toHaveBeenCalled();
    expect(backupService.executePendingArchiveBackup).not.toHaveBeenCalled();
  });
});
