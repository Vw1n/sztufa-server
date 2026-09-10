import { BadRequestException } from '@nestjs/common';
import { BackupModuleRestoreService } from './backup-module-restore.service';

describe('BackupModuleRestoreService', () => {
  const createService = (options?: { fencingCount?: number }) => {
    const cleanup = jest.fn();
    const stagingStore = {
      iterateTable: jest.fn().mockImplementation(async function* () {
        yield [];
      }),
    };
    const parsed: any = {
      manifest: {
        formatVersion: '4.0',
        scope: 'module',
        module: 'content',
        selector: {},
      },
      formatVersion: '4.0',
      scope: 'module',
      fileSha256: 'a'.repeat(64),
      compressedSize: 100,
      decompressedSize: 300,
      tableCounts: { News: 0 },
      stagingStore,
      cleanup,
    };
    const objectStore: any = {
      validateBackupKey: jest.fn(),
      getObjectBody: jest.fn().mockResolvedValue({}),
    };
    const verification: any = { parseAndValidate: jest.fn().mockResolvedValue(parsed) };

    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      backupLock: {
        updateMany: jest.fn().mockResolvedValue({ count: options?.fencingCount ?? 1 }),
      },
      backupModuleCheckpoint: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      news: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    const prisma: any = {
      $transaction: jest.fn(async (cb) => {
        return cb(tx);
      }),
    };

    const auditLog: any = { log: jest.fn().mockResolvedValue(true) };

    const backupService: any = {
      acquireBackupLock: jest.fn().mockResolvedValue({
        acquired: true,
        leaseToken: 'lease_token_123',
      }),
      startHeartbeat: jest.fn().mockImplementation(() => setInterval(() => {}, 60000)),
      orchestrateModuleBackup: jest.fn().mockResolvedValue({
        status: 'created',
        backup: { key: 'private-backups/database/modules/content/pre-restore.json.gz' },
      }),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const service = new BackupModuleRestoreService(
      prisma,
      objectStore,
      verification,
      {} as any,
      auditLog,
    );
    service.setBackupService(backupService);

    return { service, cleanup, tx, backupService };
  };

  beforeEach(() => {
    process.env.JWT_SECRET = 'module-restore-test-secret';
    process.env.BACKUP_RESTORE_ENABLED = 'true';
    process.env.BACKUP_RESTORE_CONTENT_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.BACKUP_RESTORE_ENABLED;
    delete process.env.BACKUP_RESTORE_CONTENT_ENABLED;
  });

  it('Preview 返回影响摘要、可执行状态和短时签名令牌', async () => {
    const { service, cleanup } = createService();

    const preview = await service.preview(
      'admin',
      'private-backups/database/modules/content/a.json.gz',
    );

    expect(preview).toEqual(
      expect.objectContaining({
        module: 'content',
        strategy: 'merge',
        tableCounts: { News: 0 },
        canExecute: true,
        restoreToken: expect.stringMatching(/^[^.]+\.[^.]+$/),
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('执行阶段拒绝被篡改的 Preview 令牌', async () => {
    const { service } = createService();
    await expect(
      service.execute(
        'admin',
        'private-backups/database/modules/content/a.json.gz',
        'invalid.token',
        'CONFIRM_MODULE_RESTORE',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('执行阶段成功恢复：外部租约贯穿快照与恢复事务，末尾 Fencing 成功并物理删除当前模块 Checkpoint', async () => {
    const { service, tx, backupService } = createService({ fencingCount: 1 });

    const key = 'private-backups/database/modules/content/a.json.gz';
    const preview = await service.preview('admin', key);

    const result = await service.execute(
      'admin',
      key,
      preview.restoreToken,
      'CONFIRM_MODULE_RESTORE',
    );
    expect(result).toBe('content 模块恢复成功');

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET LOCAL sztufa.preserve_updated_at = 'on'",
    );

    // 1. 验证获取模块锁
    expect(backupService.acquireBackupLock).toHaveBeenCalledWith(
      'module',
      'lock:backup:content',
      expect.any(String),
    );

    // 2. 验证快照复用 heldLease
    expect(backupService.orchestrateModuleBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'content',
        purpose: 'pre-restore',
        protected: true,
        heldLease: {
          lockKey: 'lock:backup:content',
          leaseToken: 'lease_token_123',
          owner: 'restore',
        },
      }),
    );

    // 3. 验证 CAS fencing 校验
    expect(tx.backupLock.updateMany).toHaveBeenCalledWith({
      where: {
        lockKey: 'lock:backup:content',
        leaseToken: 'lease_token_123',
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      data: {
        leaseExpiresAt: expect.any(Date),
      },
    });

    // 4. 验证物理删除当前模块 Checkpoint
    expect(tx.backupModuleCheckpoint.deleteMany).toHaveBeenCalledWith({
      where: {
        module: 'content',
        selectorKey: 'content',
      },
    });

    // 5. 验证锁释放
    expect(backupService.releaseLock).toHaveBeenCalledWith(
      'lock:backup:content',
      'lease_token_123',
    );
  });

  it('执行阶段租约失效 (Fencing failed)：事务抛出异常回滚，绝不删除 Checkpoint，且释放锁', async () => {
    const { service, tx, backupService } = createService({ fencingCount: 0 });

    const key = 'private-backups/database/modules/content/a.json.gz';
    const preview = await service.preview('admin', key);

    await expect(
      service.execute('admin', key, preview.restoreToken, 'CONFIRM_MODULE_RESTORE'),
    ).rejects.toThrow(/恢复期间租约已失效或被接管 \(fencing failed\)，事务回滚/);

    // Checkpoint 物理删除绝不被调用
    expect(tx.backupModuleCheckpoint.deleteMany).not.toHaveBeenCalled();

    // 依然在 finally 中释放锁
    expect(backupService.releaseLock).toHaveBeenCalledWith(
      'lock:backup:content',
      'lease_token_123',
    );
  });

  it('当 backupService 缺失时，execute 必须直接抛出 ServiceUnavailableException (fail-closed)', async () => {
    const serviceWithoutBackupService = new BackupModuleRestoreService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      serviceWithoutBackupService.execute('admin', 'key', 'token', 'CONFIRM_MODULE_RESTORE'),
    ).rejects.toThrow('备份排他锁编排服务未就绪，禁止执行模块恢复');
  });
});
