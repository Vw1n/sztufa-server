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

  const createPrCService = () => {
    const exportService = {
      createBackup: jest.fn().mockResolvedValue({
        key: 'private-backups/database/modules/staff/backup.json.gz',
        filename: 'backup.json.gz',
        size: 1024,
        checksum: 'mock-sha256',
      }),
    };
    const objectStore = {
      listBackups: jest.fn().mockResolvedValue([]),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue(1024),
    };

    const prisma: any = {
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'gate-id' }]),
      backupLock: {
        create: jest.fn().mockResolvedValue({ leaseToken: 'mock-lease' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      backupRun: {
        create: jest
          .fn()
          .mockImplementation((args: any) => Promise.resolve({ id: 'run-1', ...args.data })),
        upsert: jest.fn().mockResolvedValue({ id: 'run-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      backupModuleCheckpoint: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      season: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 's-archived', status: 'archived' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const fingerprintService = {
      calculateModuleFingerprint: jest.fn(),
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
      fingerprintService as any,
    );

    return { service, exportService, objectStore, prisma, fingerprintService };
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

  describe('7. PR-C 指纹变化检测、快照一致性与 Fencing 闭环', () => {
    it('指纹未变时，在持锁事务中 CAS 校验租约、更新 Checkpoint 与 BackupRun 为 skipped，不触发导出', async () => {
      const { service, exportService, prisma, fingerprintService } = createPrCService();
      const mockFp = {
        module: 'staff',
        selectorKey: 'staff',
        version: 1,
        fingerprint: 'hash-unchanged-123',
        tableFingerprints: [],
        durationMs: 10,
      };
      fingerprintService.calculateModuleFingerprint.mockResolvedValue(mockFp);

      prisma.backupModuleCheckpoint.findUnique.mockResolvedValue({
        id: 'cp-1',
        module: 'staff',
        selectorKey: 'staff',
        fingerprint: 'hash-unchanged-123',
        lastSuccessfulBackupKey: 'backups/staff.json.gz',
      });

      const res = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });

      expect(res.status).toBe('skipped');
      if (res.status === 'skipped') {
        expect(res.reason).toBe('unchanged');
      }

      // 验证未调用导出
      expect(exportService.createBackup).not.toHaveBeenCalled();

      // 验证在事务内原子更新 Checkpoint.lastObservedAt 与 BackupRun
      expect(prisma.backupModuleCheckpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cp-1' },
          data: expect.objectContaining({ lastObservedAt: expect.any(Date) }),
        }),
      );
      expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'skipped',
            skipReason: 'unchanged',
            fingerprintBefore: 'hash-unchanged-123',
          }),
        }),
      );

      // 验证持锁完成并已释放锁
      expect(prisma.backupLock.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lockKey: 'lock:backup:staff' }),
          data: expect.objectContaining({ leaseToken: null }),
        }),
      );
    });

    it('导出期间发生并发修改 (fingerprintBefore !== fingerprintAfter) 时，Checkpoint 保守不推进', async () => {
      const { service, exportService, prisma, fingerprintService } = createPrCService();

      const fpBefore = {
        module: 'staff',
        selectorKey: 'staff',
        version: 1,
        fingerprint: 'hash-initial-111',
        tableFingerprints: [],
        durationMs: 10,
      };
      const fpAfter = {
        module: 'staff',
        selectorKey: 'staff',
        version: 1,
        fingerprint: 'hash-mutated-222', // 导出期间发生变动！
        tableFingerprints: [],
        durationMs: 10,
      };

      fingerprintService.calculateModuleFingerprint
        .mockResolvedValueOnce(fpBefore)
        .mockResolvedValueOnce(fpAfter);

      const res = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });

      expect(res.status).toBe('created');
      expect(exportService.createBackup).toHaveBeenCalled();

      // 核心断言：由于指纹不一致，绝对不得 upsert Checkpoint 推进基线
      expect(prisma.backupModuleCheckpoint.upsert).not.toHaveBeenCalled();

      // 但 BackupRun 记录了实际导出的前后指纹
      expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'succeeded',
            fingerprintBefore: 'hash-initial-111',
            fingerprintAfter: 'hash-mutated-222',
          }),
        }),
      );
    });

    it('导出期间租约丢失 (lockCas.count === 0) 时，必须触发补偿物理删除并回滚', async () => {
      const { service, exportService, objectStore, prisma, fingerprintService } =
        createPrCService();

      const mockFp = {
        module: 'staff',
        selectorKey: 'staff',
        version: 1,
        fingerprint: 'hash-clean',
        tableFingerprints: [],
        durationMs: 10,
      };
      fingerprintService.calculateModuleFingerprint.mockResolvedValue(mockFp);

      // 模拟导出成功上传了 R2 对象
      exportService.createBackup.mockResolvedValue({
        key: 'private-backups/database/modules/staff/created-obj.json.gz',
        filename: 'created-obj.json.gz',
        size: 1024,
        checksum: 'mock-sha256',
      });

      // 模拟事务内 CAS 续锁核验失败（count === 0，表示租约已被其他实例抢占）
      prisma.backupLock.updateMany.mockResolvedValueOnce({ count: 0 });

      const res = await service.createScheduledBackup('cron', {
        scope: 'module',
        module: 'staff',
      });

      expect(res.status).toBe('failed');

      // 核心断言：Fencing 拦截后，必须对已上传对象执行补偿物理删除！
      expect(objectStore.deleteObject).toHaveBeenCalledWith(
        'private-backups/database/modules/staff/created-obj.json.gz',
      );

      // Checkpoint 绝不能推进
      expect(prisma.backupModuleCheckpoint.upsert).not.toHaveBeenCalled();
    });

    it('定时备份传入 legacy scope=season 时自动规范化为 module=season 并正常推进', async () => {
      const { service, exportService, prisma, fingerprintService } = createPrCService();
      const mockFp = {
        module: 'season',
        selectorKey: 'season:s1',
        version: 1,
        fingerprint: 'hash-season-1',
        tableFingerprints: [],
        durationMs: 10,
      };
      fingerprintService.calculateModuleFingerprint.mockResolvedValue(mockFp);

      exportService.createBackup.mockResolvedValue({
        key: 'private-backups/database/modules/season/season-s1.json.gz',
        filename: 'season-s1.json.gz',
        size: 2048,
        checksum: 'mock-sha256-season',
      });

      const res = await service.createScheduledBackup('cron', {
        scope: 'season',
        seasonId: 's1',
      });

      expect(res.status).toBe('created');
      expect(res.module).toBe('season');
      expect(res.selector).toEqual({ seasonId: 's1' });
      expect(exportService.createBackup).toHaveBeenCalledWith(
        'cron',
        expect.objectContaining({
          scope: 'module',
          module: 'season',
          selector: { seasonId: 's1' },
        }),
      );
      expect(prisma.backupModuleCheckpoint.upsert).toHaveBeenCalled();
    });

    it('定时备份显式传入 scope=season 但缺少 seasonId 时必须抛出 BadRequestException (400)', async () => {
      const { service } = createPrCService();
      await expect(
        service.createScheduledBackup('cron', {
          scope: 'season',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('7. Neon 官方 4GB 配额超限守卫与归档重备控制', () => {
    it('isNeonOfficialQuotaExceeded 决策逻辑验证：正常超限、未超限与各种降级分支', async () => {
      const { service } = createPrCService();
      const mockNeonTraffic: any = {
        fetchMonthlyTraffic: jest.fn(),
        isCurrentBillingPeriod: jest.fn(),
      };
      (service as any).neonTrafficService = mockNeonTraffic;

      // 1. 正常超限 (4.2GB, active, not stale, valid billing period)
      mockNeonTraffic.fetchMonthlyTraffic.mockResolvedValue({
        status: 'active',
        stale: false,
        dataTransferBytes: 4.2 * 1024 * 1024 * 1024,
      });
      mockNeonTraffic.isCurrentBillingPeriod.mockReturnValue(true);

      const res1 = await service.isNeonOfficialQuotaExceeded();
      expect(res1.exceeded).toBe(true);
      expect(res1.degraded).toBe(false);
      expect(res1.reason).toBe('traffic_quota_exceeded');

      // 2. 正常未超限 (2.5GB)
      mockNeonTraffic.fetchMonthlyTraffic.mockResolvedValue({
        status: 'active',
        stale: false,
        dataTransferBytes: 2.5 * 1024 * 1024 * 1024,
      });
      const res2 = await service.isNeonOfficialQuotaExceeded();
      expect(res2.exceeded).toBe(false);
      expect(res2.degraded).toBe(false);

      // 3. 官方数据不可用 (unavailable) -> fail-open 降级
      mockNeonTraffic.fetchMonthlyTraffic.mockResolvedValue({
        status: 'unavailable',
        stale: true,
        dataTransferBytes: null,
      });
      const res3 = await service.isNeonOfficialQuotaExceeded();
      expect(res3.exceeded).toBe(false);
      expect(res3.degraded).toBe(true);
      expect(res3.reason).toBe('unavailable');

      // 4. 数据过期 (stale) -> fail-open 降级
      mockNeonTraffic.fetchMonthlyTraffic.mockResolvedValue({
        status: 'active',
        stale: true,
        dataTransferBytes: 4.5 * 1024 * 1024 * 1024,
      });
      const res4 = await service.isNeonOfficialQuotaExceeded();
      expect(res4.exceeded).toBe(false);
      expect(res4.degraded).toBe(true);
      expect(res4.reason).toBe('stale');

      // 5. 账期跨月不匹配 -> fail-open 降级
      mockNeonTraffic.fetchMonthlyTraffic.mockResolvedValue({
        status: 'active',
        stale: false,
        dataTransferBytes: 4.5 * 1024 * 1024 * 1024,
      });
      mockNeonTraffic.isCurrentBillingPeriod.mockReturnValue(false);
      const res5 = await service.isNeonOfficialQuotaExceeded();
      expect(res5.exceeded).toBe(false);
      expect(res5.degraded).toBe(true);
      expect(res5.reason).toBe('billing_period_mismatch');
    });

    it('归档赛季已有保护备份且配额超限时：暂停非必要重备份，写入 traffic_quota_exceeded 与审计告警', async () => {
      const { service, exportService, prisma } = createPrCService();
      prisma.auditLog = { create: jest.fn().mockResolvedValue({}) };

      jest.spyOn(service, 'isNeonOfficialQuotaExceeded').mockResolvedValue({
        exceeded: true,
        degraded: false,
        reason: 'traffic_quota_exceeded',
      });
      jest.spyOn(service, 'hasValidProtectedBackupForSeason').mockResolvedValue(true);

      const res = await service.executeArchiveSeasonBackupWithLock(
        'admin',
        's-archived',
        'archive',
      );

      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('traffic_quota_exceeded');
      expect(exportService.createBackup).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'AUDIT_TRAFFIC_QUOTA_EXCEEDED',
            details: expect.stringContaining('s-archived'),
          }),
        }),
      );
    });

    it('归档赛季缺失保护备份但配额超限时：判定为核心必要补缺，记录紧急审计告警并继续执行备份', async () => {
      const { service, exportService, prisma } = createPrCService();
      prisma.auditLog = { create: jest.fn().mockResolvedValue({}) };

      jest.spyOn(service, 'isNeonOfficialQuotaExceeded').mockResolvedValue({
        exceeded: true,
        degraded: false,
        reason: 'traffic_quota_exceeded',
      });
      jest.spyOn(service, 'hasValidProtectedBackupForSeason').mockResolvedValue(false);

      exportService.createBackup.mockResolvedValue({
        key: 'private-backups/database/modules/season/s-archived.json.gz',
        filename: 's-archived.json.gz',
        size: 2048,
        checksum: 'mock-checksum',
      });

      const res = await service.executeArchiveSeasonBackupWithLock(
        'admin',
        's-archived',
        'archive',
      );

      expect(res.status).toBe('succeeded');
      expect(exportService.createBackup).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'EMERGENCY_ARCHIVE_BACKFILL_UNDER_QUOTA',
            details: expect.stringContaining('s-archived'),
          }),
        }),
      );
    });
  });
});
