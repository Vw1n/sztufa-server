import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync, execSync } from 'child_process';
import { StartupMigrationService } from './startup-migration.service';

jest.mock('child_process', () => ({
  ...(jest.requireActual('child_process') as any),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
}));

describe('StartupMigrationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (StartupMigrationService as any).hasRun = false;
    (StartupMigrationService as any).runPromise = null;
  });

  it('已有名单和新闻时只预计算全部赛季缓存', async () => {
    const rosterCount: any = jest.fn();
    const newsCount: any = jest.fn();
    const findSeasons: any = jest.fn();
    const computeAndCache: any = jest.fn(async () => ({ success: true }));
    rosterCount.mockResolvedValue(1);
    newsCount.mockResolvedValue(1);
    findSeasons.mockResolvedValue([{ id: 'season-1' }, { id: 'season-2' }]);
    const prisma: any = {
      seasonTeamPlayer: { count: rosterCount },
      news: { count: newsCount },
      season: { findMany: findSeasons },
    };
    const seasonStatistics: any = { computeAndCache };

    await new StartupMigrationService(prisma, seasonStatistics).run();

    expect(seasonStatistics.computeAndCache).toHaveBeenNthCalledWith(1, 'season-1');
    expect(seasonStatistics.computeAndCache).toHaveBeenNthCalledWith(2, 'season-2');
  });

  it('非 test 环境下当 prisma migrate deploy 失败时应抛出错误并终止初始化', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL;

    (execSync as jest.Mock).mockImplementation(() => {
      throw new Error('Migration database error');
    });

    const runSpy = jest.fn();
    const service = new StartupMigrationService({} as any, {} as any);
    jest.spyOn(service, 'run').mockImplementation(runSpy as any);

    try {
      await expect(service.onModuleInit()).rejects.toThrow('Migration database error');
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('Vercel 冷启动默认跳过全库维护任务', async () => {
    const originalVercel = process.env.VERCEL;
    const originalOptIn = process.env.RUN_STARTUP_MAINTENANCE_ON_BOOT;
    process.env.VERCEL = '1';
    delete process.env.RUN_STARTUP_MAINTENANCE_ON_BOOT;

    const service = new StartupMigrationService({} as any, {} as any);
    const runSpy = jest.spyOn(service, 'run').mockResolvedValue();

    try {
      await service.onModuleInit();
      expect(runSpy).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();
    } finally {
      if (originalVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = originalVercel;
      if (originalOptIn === undefined) delete process.env.RUN_STARTUP_MAINTENANCE_ON_BOOT;
      else process.env.RUN_STARTUP_MAINTENANCE_ON_BOOT = originalOptIn;
    }
  });

  it('开发环境开关启用时在 Vercel 运行时通过连接池应用迁移', async () => {
    const originalVercel = process.env.VERCEL;
    const originalOptIn = process.env.ALLOW_RUNTIME_DATABASE_MIGRATIONS;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.VERCEL = '1';
    process.env.ALLOW_RUNTIME_DATABASE_MIGRATIONS = 'true';
    process.env.DATABASE_URL = 'postgresql://runtime-pool/database';

    const service = new StartupMigrationService({} as any, {} as any);

    try {
      await service.onModuleInit();
      expect(execFileSync).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringContaining('prisma'), 'migrate', 'deploy'],
        expect.objectContaining({
          env: expect.objectContaining({
            DIRECT_URL: 'postgresql://runtime-pool/database',
          }),
        }),
      );
    } finally {
      if (originalVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = originalVercel;
      if (originalOptIn === undefined) delete process.env.ALLOW_RUNTIME_DATABASE_MIGRATIONS;
      else process.env.ALLOW_RUNTIME_DATABASE_MIGRATIONS = originalOptIn;
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('启动任务失败后允许后续调用重试', async () => {
    const rosterCount = jest
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('temporary error'))
      .mockResolvedValueOnce(1);
    const prisma: any = {
      seasonTeamPlayer: { count: rosterCount },
      news: { count: jest.fn<() => Promise<number>>().mockResolvedValue(1) },
      season: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]) },
    };

    const service = new StartupMigrationService(prisma, { computeAndCache: jest.fn() } as any);
    await service.run();
    await service.run();

    expect(rosterCount).toHaveBeenCalledTimes(2);
  });
});
