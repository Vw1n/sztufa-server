import { ServiceUnavailableException } from '@nestjs/common';
import { BackupService, LEASE_TTL_MS } from './backup.service';

describe('BackupLock Gate Arbitration & TOCTOU Prevention Spec', () => {
  let service: BackupService;
  let prismaMock: any;
  let exportService: any;
  let lockStorage: Map<
    string,
    {
      id: string;
      lockKey: string;
      leaseToken: string | null;
      leaseExpiresAt: Date | null;
      holderInstance: string | null;
    }
  >;

  beforeEach(() => {
    lockStorage = new Map();
    // 预置 gate 行
    lockStorage.set('lock:backup:gate', {
      id: 'gate-id-1',
      lockKey: 'lock:backup:gate',
      leaseToken: null,
      leaseExpiresAt: null,
      holderInstance: null,
    });

    prismaMock = {
      $transaction: jest.fn().mockImplementation(async (callback: any) => {
        return callback(prismaMock);
      }),
      $queryRaw: jest.fn().mockImplementation(async (query: any) => {
        const text = Array.isArray(query) ? query.join('') : query.text || String(query);
        if (text.includes('lock:backup:gate')) {
          const gate = lockStorage.get('lock:backup:gate');
          return gate ? [{ id: gate.id }] : [];
        }
        return [];
      }),
      backupLock: {
        findUnique: jest.fn().mockImplementation(async ({ where: { lockKey } }: any) => {
          return lockStorage.get(lockKey) || null;
        }),
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          for (const item of lockStorage.values()) {
            if (args.where?.lockKey && item.lockKey !== args.where.lockKey) continue;
            if (
              args.where?.leaseExpiresAt?.gt &&
              (!item.leaseExpiresAt || item.leaseExpiresAt <= args.where.leaseExpiresAt.gt)
            )
              continue;
            if (args.where?.leaseToken?.not === null && !item.leaseToken) continue;
            return item;
          }
          return null;
        }),
        count: jest.fn().mockImplementation(async (args: any) => {
          let c = 0;
          for (const item of lockStorage.values()) {
            if (
              args.where?.lockKey?.startsWith &&
              !item.lockKey.startsWith(args.where.lockKey.startsWith)
            )
              continue;
            if (args.where?.lockKey?.notIn && args.where.lockKey.notIn.includes(item.lockKey))
              continue;
            if (
              args.where?.leaseExpiresAt?.gt &&
              (!item.leaseExpiresAt || item.leaseExpiresAt <= args.where.leaseExpiresAt.gt)
            )
              continue;
            if (args.where?.leaseToken?.not === null && !item.leaseToken) continue;
            c++;
          }
          return c;
        }),
        upsert: jest
          .fn()
          .mockImplementation(async ({ where: { lockKey }, create, update }: any) => {
            const existing = lockStorage.get(lockKey);
            if (existing) {
              const updated = { ...existing, ...update };
              lockStorage.set(lockKey, updated);
              return updated;
            } else {
              const created = { id: `id-${lockKey}`, ...create };
              lockStorage.set(lockKey, created);
              return created;
            }
          }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const existing = lockStorage.get(where.lockKey);
          if (!existing) return { count: 0 };
          if (where.leaseToken && existing.leaseToken !== where.leaseToken) return { count: 0 };
          if (
            where.leaseExpiresAt?.gt &&
            (!existing.leaseExpiresAt || existing.leaseExpiresAt <= where.leaseExpiresAt.gt)
          ) {
            return { count: 0 };
          }
          const updated = { ...existing, ...data };
          lockStorage.set(where.lockKey, updated);
          return { count: 1 };
        }),
      },
      backupRun: {
        create: jest
          .fn()
          .mockImplementation((args: any) => Promise.resolve({ id: 'run-1', ...args.data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      backupModuleCheckpoint: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      season: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1' }),
      },
    };

    exportService = {
      createBackup: jest.fn().mockResolvedValue({
        key: 'private-backups/database/modules/season/season_123.json.gz',
        formatVersion: '4.0',
        scope: 'module',
        module: 'season',
        size: 1024,
        checksum: 'sha256-abc',
      }),
    };
    const scopeService: any = {
      validateSeason: jest.fn().mockResolvedValue({ id: 's1', name: 'Season 1' }),
    };
    const objectStore: any = {
      deleteObject: jest.fn().mockResolvedValue(true),
    };

    service = new BackupService(
      exportService,
      {} as any,
      {} as any,
      {} as any,
      objectStore,
      {} as any,
      scopeService,
      {} as any,
      prismaMock,
      {} as any,
    );
  });

  describe('1. Gate 行缺失 fail-closed 拦截', () => {
    it('当数据库中缺失 lock:backup:gate 记录时，必须抛出 ServiceUnavailableException', async () => {
      lockStorage.delete('lock:backup:gate');

      await expect(
        service.acquireBackupLock('full', 'lock:backup:global:full', 'inst-1'),
      ).rejects.toThrow(ServiceUnavailableException);

      await expect(
        service.acquireBackupLock('module', 'lock:backup:staff', 'inst-1'),
      ).rejects.toThrow('备份仲裁系统异常: Gate 锁记录缺失 (fail-closed)');
    });
  });

  describe('2. 全量锁防覆写与并发拦截', () => {
    it('已有处于有效租约期的全量锁时，第二个全量请求返回 duplicate_in_flight 且绝不覆写原有租约', async () => {
      // 1. 第一个全量请求成功申请锁
      const firstRes = await service.acquireBackupLock('full', 'lock:backup:global:full', 'inst-1');
      expect(firstRes.acquired).toBe(true);
      const originalToken = (firstRes as any).leaseToken;
      expect(originalToken).toBeDefined();

      // 2. 第二个全量请求并发到达
      const secondRes = await service.acquireBackupLock(
        'full',
        'lock:backup:global:full',
        'inst-2',
      );
      expect(secondRes.acquired).toBe(false);
      expect((secondRes as any).reason).toBe('duplicate_in_flight');

      // 3. 核心断言：原有有效全量租约令牌保持不变，未被覆盖！
      const currentFullLock = lockStorage.get('lock:backup:global:full');
      expect(currentFullLock?.leaseToken).toBe(originalToken);
      expect(currentFullLock?.holderInstance).toBe('inst-1');
    });

    it('当全量锁已过期时，新请求能安全接管', async () => {
      // 模拟已超期的全量锁
      lockStorage.set('lock:backup:global:full', {
        id: 'full-id',
        lockKey: 'lock:backup:global:full',
        leaseToken: 'old-expired-token',
        leaseExpiresAt: new Date(Date.now() - 1000), // 已过期
        holderInstance: 'old-inst',
      });

      const res = await service.acquireBackupLock('full', 'lock:backup:global:full', 'new-inst');
      expect(res.acquired).toBe(true);
      expect((res as any).leaseToken).not.toBe('old-expired-token');

      const current = lockStorage.get('lock:backup:global:full');
      expect(current?.holderInstance).toBe('new-inst');
    });
  });

  describe('3. 全量锁与模块锁相互互斥仲裁 (消除 TOCTOU)', () => {
    it('当有活跃模块备份正在执行时，全量备份请求被拦截并返回 active_module_in_flight', async () => {
      // 实例 1 先获取了 staff 模块锁
      const modRes = await service.acquireBackupLock('module', 'lock:backup:staff', 'inst-mod-1');
      expect(modRes.acquired).toBe(true);

      // 实例 2 尝试发起全量备份
      const fullRes = await service.acquireBackupLock(
        'full',
        'lock:backup:global:full',
        'inst-full-1',
      );
      expect(fullRes.acquired).toBe(false);
      expect((fullRes as any).reason).toBe('active_module_in_flight');
    });

    it('当有活跃全量备份正在执行时，任何模块备份请求被拦截并返回 global_full_in_flight', async () => {
      // 实例 1 先获取了全量锁
      const fullRes = await service.acquireBackupLock(
        'full',
        'lock:backup:global:full',
        'inst-full-1',
      );
      expect(fullRes.acquired).toBe(true);

      // 实例 2 尝试发起 staff 模块备份
      const modRes1 = await service.acquireBackupLock('module', 'lock:backup:staff', 'inst-mod-1');
      expect(modRes1.acquired).toBe(false);
      expect((modRes1 as any).reason).toBe('global_full_in_flight');

      // 实例 3 尝试发起 season 模块备份
      const modRes2 = await service.acquireBackupLock(
        'module',
        'lock:backup:season:s1',
        'inst-mod-2',
      );
      expect(modRes2.acquired).toBe(false);
      expect((modRes2 as any).reason).toBe('global_full_in_flight');
    });

    it('不同模块之间可以并发持有各自的模块锁', async () => {
      const staffRes = await service.acquireBackupLock('module', 'lock:backup:staff', 'inst-1');
      const contentRes = await service.acquireBackupLock('module', 'lock:backup:content', 'inst-2');
      const seasonRes = await service.acquireBackupLock(
        'module',
        'lock:backup:season:s1',
        'inst-3',
      );

      expect(staffRes.acquired).toBe(true);
      expect(contentRes.acquired).toBe(true);
      expect(seasonRes.acquired).toBe(true);

      // 同一模块不可重复并发
      const duplicateStaffRes = await service.acquireBackupLock(
        'module',
        'lock:backup:staff',
        'inst-4',
      );
      expect(duplicateStaffRes.acquired).toBe(false);
      expect((duplicateStaffRes as any).reason).toBe('duplicate_in_flight');
    });
  });

  describe('4. 显式释放锁与心跳续约', () => {
    it('releaseLock 正确清空 leaseToken 与 leaseExpiresAt', async () => {
      const lock = await service.acquireBackupLock('module', 'lock:backup:staff', 'inst-1');
      expect(lock.acquired).toBe(true);
      const token = (lock as any).leaseToken;

      const released = await service.releaseLock('lock:backup:staff', token);
      expect(released).toBe(true);

      const record = lockStorage.get('lock:backup:staff');
      expect(record?.leaseToken).toBeNull();
      expect(record?.leaseExpiresAt).toBeNull();

      // 释放后可再次被申请
      const lockAgain = await service.acquireBackupLock('module', 'lock:backup:staff', 'inst-2');
      expect(lockAgain.acquired).toBe(true);
    });

    it('startHeartbeat 在租约有效期内持续刷新过期时间；失锁时触发 abort', async () => {
      const abortController = new AbortController();
      const leaseToken = 'heartbeat-token';
      lockStorage.set('lock:backup:staff', {
        id: 'staff-id',
        lockKey: 'lock:backup:staff',
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 5000),
        holderInstance: 'inst-1',
      });

      const timer = service.startHeartbeat(
        { lockKey: 'lock:backup:staff', leaseToken },
        abortController,
        50, // 50ms 快速间隔测试
      );

      // 等待心跳执行一次
      await new Promise((resolve) => setTimeout(resolve, 120));

      const renewed = lockStorage.get('lock:backup:staff');
      expect(renewed?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() + LEASE_TTL_MS - 10000);
      expect(abortController.signal.aborted).toBe(false);

      // 模拟锁被抢走（leaseToken 变成 other-token）
      lockStorage.set('lock:backup:staff', {
        ...renewed!,
        leaseToken: 'hijacked-token',
      });

      // 再次等待心跳执行
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(abortController.signal.aborted).toBe(true);

      clearInterval(timer);
    });
  });

  describe('5. Legacy scope=season 规范化为 module=season 并参与统一锁互斥', () => {
    it('全量锁处于活跃状态时，调用 legacy scope=season 备份必须被 Gate 仲裁拦截 (active_full_lock)', async () => {
      lockStorage.set('lock:backup:global:full', {
        id: 'full-id',
        lockKey: 'lock:backup:global:full',
        leaseToken: 'full-lease-token',
        leaseExpiresAt: new Date(Date.now() + 60000),
        holderInstance: 'inst-full',
      });

      await expect(
        service.createBackup('admin', { scope: 'season', seasonId: 's1' }),
      ).rejects.toThrow(/global_full_in_flight/);
    });

    it('当持有 legacy scope=season 模块锁时，全量备份必须被拦截 (active_module_lock)', async () => {
      lockStorage.set('lock:backup:season:s1', {
        id: 'season-id',
        lockKey: 'lock:backup:season:s1',
        leaseToken: 'season-lease-token',
        leaseExpiresAt: new Date(Date.now() + 60000),
        holderInstance: 'inst-season',
      });

      await expect(service.createBackup('admin', { scope: 'full' })).rejects.toThrow(
        /active_module_in_flight/,
      );
    });

    it('调用 legacy scope=season 备份正常执行时，规范化为 module=season 并申请 lock:backup:season:s1', async () => {
      const res = await service.createBackup('admin', { scope: 'season', seasonId: 's1' });
      expect(res.key).toBe('private-backups/database/modules/season/season_123.json.gz');
      expect(exportService.createBackup).toHaveBeenCalledWith(
        'admin',
        expect.objectContaining({
          scope: 'module',
          module: 'season',
          selector: { seasonId: 's1' },
        }),
      );
    });
  });
});
