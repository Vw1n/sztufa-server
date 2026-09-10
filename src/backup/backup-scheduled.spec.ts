import { BadRequestException } from '@nestjs/common';
import { BackupService, REQUIRED_MODULES, getShanghaiPeriodKey } from './backup.service';

describe('BackupService 月度模块化备份与批次状态机测试', () => {
  const createService = (backups: any[] = []) => {
    const exportService = {
      createBackup: jest.fn().mockResolvedValue({
        key: 'private-backups/database/modules/staff/backup.json.gz',
        filename: 'backup.json.gz',
        size: 1024,
      }),
    };
    const objectStore = { listBackups: jest.fn().mockResolvedValue(backups) };
    const prismaModels = [
      'team',
      'player',
      'match',
      'news',
      'season',
      'prediction',
      'seasonTeamProfile',
      'adminFormDraft',
      'goal',
      'matchEvent',
      'seasonTeamPlayer',
      'teamRegistration',
      'user',
      'memberAccount',
      'auditLog',
      'historyImportBatch',
      'pdfImportBatch',
    ];
    const prisma: any = Object.fromEntries(
      prismaModels.map((model) => [
        model,
        {
          aggregate: jest.fn().mockResolvedValue({ _max: {} }),
          findFirst: jest.fn().mockResolvedValue({ id: 'season-active' }),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      ]),
    );
    prisma.backupBatch = {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    const service = new BackupService(
      exportService as any,
      {} as any,
      {} as any,
      {} as any,
      objectStore as any,
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
    );
    return { service, exportService, objectStore, prisma };
  };

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS;
    delete process.env.SCHEDULED_BACKUP_CHANGE_DETECTION_ENABLED;
  });

  describe('1. 全量备份严格拦截与时区规范', () => {
    it('显式传入 scope=full 必须抛出 BadRequestException 拦截', async () => {
      const { service } = createService();
      await expect(service.createScheduledBackup('cron', { scope: 'full' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createScheduledBackup('cron', { scope: 'full' })).rejects.toThrow(
        '定时备份禁止全量备份 (scope=full)',
      );
    });

    it('getShanghaiPeriodKey 始终基于 Asia/Shanghai 时区计算月份 YYYY-MM', () => {
      // 2026-08-31 22:00:00 UTC 对应北京时间 2026-09-01 06:00:00
      const utcDate = new Date('2026-08-31T22:00:00.000Z');
      expect(getShanghaiPeriodKey(utcDate)).toBe('2026-09');
    });
  });

  describe('2. 最小备份间隔与变化检测判断方向', () => {
    it('上次备份晚于或等于截止点 (latestBackupTime >= cutoff) 处于间隔保护期内，判定为 minimum_interval', async () => {
      process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '24';
      const now = Date.now();
      const existing = {
        key: 'private-backups/database/modules/staff/recent.json.gz',
        scope: 'module',
        module: 'staff',
        purpose: 'scheduled',
        lastModified: new Date(now - 2 * 60 * 60 * 1000), // 2小时前，晚于 cutoff (24小时前)
      };
      const { service, exportService } = createService([existing]);

      const result = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('minimum_interval');
        expect(result.existingBackup).toBe(existing);
      }
      expect(exportService.createBackup).not.toHaveBeenCalled();
    });

    it('上次备份早于截止点且有业务数据变化时，正常创建备份 (created)', async () => {
      process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '24';
      const now = Date.now();
      const oldBackupTime = new Date(now - 48 * 60 * 60 * 1000); // 48小时前
      const existing = {
        key: 'private-backups/database/modules/staff/old.json.gz',
        scope: 'module',
        module: 'staff',
        purpose: 'scheduled',
        lastModified: oldBackupTime,
      };
      const { service, exportService, prisma } = createService([existing]);
      prisma.user.aggregate.mockResolvedValue({
        _max: { updatedAt: new Date(now - 10 * 60 * 1000) }, // 10分钟前更新
      });

      const result = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });
      expect(result.status).toBe('created');
      if (result.status === 'created') {
        expect(result.module).toBe('staff');
        expect(result.backup).toBeDefined();
      }
      expect(exportService.createBackup).toHaveBeenCalled();
    });

    it('上次备份早于截止点但无业务数据变化时，判定为 unchanged 跳过', async () => {
      process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '24';
      const now = Date.now();
      const oldBackupTime = new Date(now - 48 * 60 * 60 * 1000);
      const existing = {
        key: 'private-backups/database/modules/staff/old.json.gz',
        scope: 'module',
        module: 'staff',
        purpose: 'scheduled',
        lastModified: oldBackupTime,
      };
      const { service, exportService, prisma } = createService([existing]);
      prisma.user.aggregate.mockResolvedValue({
        _max: { updatedAt: new Date(oldBackupTime.getTime() - 1000) }, // 比上次备份更早
      });

      const result = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('unchanged');
      }
      expect(exportService.createBackup).not.toHaveBeenCalled();
    });
  });

  describe('3. 五模块有序执行与无活跃赛季安全处理', () => {
    it('按 season -> staff -> members -> content -> operations 依次执行五模块并记录 succeeded', async () => {
      const { service, prisma } = createService();
      let createdBatch: any = null;
      prisma.backupBatch.create.mockImplementation((args: any) => {
        createdBatch = { ...args.data, id: 'batch_test_1' };
        return Promise.resolve(createdBatch);
      });
      prisma.backupBatch.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.createScheduledBackupBatch('cron');
      expect(res.status).toBe('succeeded');
      expect(res.items.map((i) => i.module)).toEqual(REQUIRED_MODULES);
      expect(res.succeeded).toBe(5);
      expect(res.failed).toBe(0);
    });

    it('无活跃赛季时 season 模块安全跳过 (no_eligible_season)，严禁兜底全量', async () => {
      const { service, prisma, exportService } = createService();
      prisma.season.findFirst.mockResolvedValue(null); // 无活跃赛季
      prisma.backupBatch.create.mockImplementation((args: any) => {
        return Promise.resolve({ ...args.data, id: 'batch_no_season' });
      });
      prisma.backupBatch.updateMany.mockImplementation(() => {
        return Promise.resolve({ count: 1 });
      });

      const res = await service.createScheduledBackupBatch('cron');
      expect(res.status).toBe('succeeded'); // skipped 仍属已满足项
      const seasonItem = res.items.find((i) => i.module === 'season');
      expect(seasonItem).toBeDefined();
      expect(seasonItem?.status).toBe('skipped');
      if (seasonItem?.status === 'skipped') {
        expect(seasonItem.reason).toBe('no_eligible_season');
      }
      // 验证绝不触发全量导出
      const calls = exportService.createBackup.mock.calls;
      for (const call of calls) {
        expect(call[1].scope).not.toBe('full');
      }
    });
  });

  describe('4. CAS 租约并发与接管机制', () => {
    it('首次创建命中 P2002 冲突后转入检查；若已有有效租约则安全退出', async () => {
      const { service, prisma } = createService();
      const p2002Error: any = new Error('Unique constraint failed on periodKey');
      p2002Error.code = 'P2002';
      prisma.backupBatch.create.mockRejectedValue(p2002Error);
      prisma.backupBatch.findUnique.mockResolvedValue({
        id: 'batch_existing',
        periodKey: getShanghaiPeriodKey(),
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + 100_000), // 有效租约
      });

      const leaseRes = await service.acquireBatchLease(getShanghaiPeriodKey(), 'cron');
      expect(leaseRes.acquired).toBe(false);
      if (leaseRes.acquired === false) {
        expect((leaseRes as any).reason).toBe('running_active_lease');
      }
    });

    it('双实例并发接管 stale 批次时，只有 CAS 成功的实例能获得租约', async () => {
      const { service, prisma } = createService();
      const p2002Error: any = new Error('Unique constraint failed');
      p2002Error.code = 'P2002';
      prisma.backupBatch.create.mockRejectedValue(p2002Error);
      prisma.backupBatch.findUnique.mockResolvedValue({
        id: 'batch_stale',
        periodKey: getShanghaiPeriodKey(),
        status: 'running',
        leaseExpiresAt: new Date(Date.now() - 1000), // 租约已超时
      });

      // 模拟实例 1 成功，实例 2 失败
      prisma.backupBatch.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const lease1 = await service.acquireBatchLease(getShanghaiPeriodKey(), 'cron');
      const lease2 = await service.acquireBatchLease(getShanghaiPeriodKey(), 'cron');

      expect(lease1.acquired).toBe(true);
      expect(lease2.acquired).toBe(false);
      if (lease2.acquired === false) {
        expect((lease2 as any).reason).toBe('cas_conflict');
      }
    });
  });

  describe('5. 流水线逐项落库、断点补跑与重试去重', () => {
    it('首个模块落库后模拟中断，接管实例只补跑剩余模块且覆盖替换', async () => {
      const { service, prisma, exportService } = createService();
      const existingSeasonItem = {
        status: 'created',
        module: 'season',
        selector: { seasonId: 'season-active' },
        backup: { key: 'season.json.gz' },
        durationMs: 100,
        finishedAt: new Date().toISOString(),
      };
      const existingFailedStaff = {
        status: 'failed',
        module: 'staff',
        selector: {},
        reason: 'export_error',
        error: '上次网络中断',
        finishedAt: new Date().toISOString(),
      };

      // 模拟断点接管 incomplete 批次
      const existingBatch = {
        id: 'batch_incomplete',
        periodKey: getShanghaiPeriodKey(),
        targetSeasonId: 'season-active',
        status: 'incomplete',
        items: [existingSeasonItem, existingFailedStaff],
      };

      prisma.backupBatch.findUnique.mockResolvedValue(existingBatch);
      prisma.backupBatch.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.retryScheduledBackupBatch('batch_incomplete', 'admin');
      expect(res.status).toBe('succeeded');
      // season 已经 created，因此不应再次调用 exportService 处理 season
      const seasonCalls = exportService.createBackup.mock.calls.filter(
        (c) => c[1].module === 'season',
      );
      expect(seasonCalls.length).toBe(0);

      // staff 重新成功后，items 中应当覆盖原有的失败项，不产生同模块重复
      const staffItems = res.items.filter((i) => i.module === 'staff');
      expect(staffItems.length).toBe(1);
      expect(staffItems[0].status).toBe('created');
    });

    it('租约过期后，逐项落库 CAS 失败必须立即抛错中止', async () => {
      const { service, prisma } = createService();
      prisma.backupBatch.create.mockResolvedValue({
        id: 'batch_lease_loss',
        periodKey: getShanghaiPeriodKey(),
        status: 'running',
        targetSeasonId: 'season-active',
        items: [],
      });
      // 模拟在落库时租约已被抢走 (count = 0)
      prisma.backupBatch.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.createScheduledBackupBatch('cron')).rejects.toThrow(
        '批次执行租约已过期或被其他实例接管',
      );
    });

    it('终态更新时若租约已被接管 (count = 0)，执行者必须抛错不得报告成功', async () => {
      const { service, prisma } = createService();
      prisma.backupBatch.create.mockResolvedValue({
        id: 'batch_final_loss',
        periodKey: getShanghaiPeriodKey(),
        status: 'running',
        targetSeasonId: 'season-active',
        items: [],
      });
      // 前 5 次模块落库成功，最后终态更新时 count = 0
      prisma.backupBatch.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(service.createScheduledBackupBatch('cron')).rejects.toThrow(
        '批次终态写入失败：租约已失效或被其他实例抢占',
      );
    });
  });

  describe('6. 批次列表查询严格参数校验与分页', () => {
    it('支持 limit、offset 分页与 total 计算', async () => {
      const { service, prisma } = createService();
      prisma.backupBatch.count.mockResolvedValue(42);
      prisma.backupBatch.findMany.mockResolvedValue([
        { id: 'b_1', periodKey: '2026-09', status: 'succeeded' },
        { id: 'b_2', periodKey: '2026-08', status: 'succeeded' },
      ]);

      const res = await service.listBackupBatches({
        status: 'succeeded',
        periodKey: '2026-09',
        limit: 10,
        offset: 20,
      });

      expect(res.total).toBe(42);
      expect(res.limit).toBe(10);
      expect(res.offset).toBe(20);
      expect(res.items.length).toBe(2);

      expect(prisma.backupBatch.findMany).toHaveBeenCalledWith({
        where: { status: 'succeeded', periodKey: '2026-09' },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 10,
      });
    });

    it('服务层拒绝非法 limit 与 offset 并明确抛出 BadRequestException', async () => {
      const { service } = createService();

      await expect(service.listBackupBatches({ limit: 0 })).rejects.toThrow(
        'limit 必须为 1 到 100 之间的整数',
      );
      await expect(service.listBackupBatches({ limit: 101 })).rejects.toThrow(
        'limit 必须为 1 到 100 之间的整数',
      );
      await expect(service.listBackupBatches({ limit: 1.5 as any })).rejects.toThrow(
        'limit 必须为 1 到 100 之间的整数',
      );
      await expect(service.listBackupBatches({ offset: -1 })).rejects.toThrow(
        'offset 必须为大于或等于 0 的整数',
      );
      await expect(service.listBackupBatches({ offset: 2.5 as any })).rejects.toThrow(
        'offset 必须为大于或等于 0 的整数',
      );
    });
  });
});
