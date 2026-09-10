import { BadRequestException } from '@nestjs/common';
import { BackupRestoreService } from './backup-restore.service';
import { RESTORE_DELETE_ORDER, TABLE_METADATA_MAP } from './backup-table-registry';

describe('BackupRestoreService', () => {
  const createService = (options?: { fencingCount?: number }) => {
    const cleanup = jest.fn();
    const stagingStore = {
      iterateTable: jest.fn().mockImplementation(async function* () {
        yield [];
      }),
    };
    const parsed: any = {
      formatVersion: '3.0',
      scope: 'all',
      fileSha256: 'a'.repeat(64),
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
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      teamRegistration: {
        count: jest.fn().mockResolvedValue(0),
      },
      campusCardAsset: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      match: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      player: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      backupLock: {
        updateMany: jest.fn().mockResolvedValue({ count: options?.fencingCount ?? 1 }),
      },
      backupModuleCheckpoint: {
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
    };

    for (const tbl of RESTORE_DELETE_ORDER) {
      const meta = TABLE_METADATA_MAP[tbl];
      const delegate = meta ? meta.prismaDelegateName : tbl.charAt(0).toLowerCase() + tbl.slice(1);
      if (!tx[delegate]) {
        tx[delegate] = {};
      }
      tx[delegate].deleteMany =
        tx[delegate].deleteMany || jest.fn().mockResolvedValue({ count: 0 });
      tx[delegate].createMany =
        tx[delegate].createMany || jest.fn().mockResolvedValue({ count: 0 });
    }

    const prisma: any = {
      teamRegistration: {
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn(async (cb) => {
        return cb(tx);
      }),
    };

    const auditLog: any = { log: jest.fn().mockResolvedValue(true) };

    const backupService: any = {
      acquireBackupLock: jest.fn().mockResolvedValue({
        acquired: true,
        leaseToken: 'lease_token_full_123',
      }),
      startHeartbeat: jest.fn().mockImplementation(() => setInterval(() => {}, 60000)),
      orchestrateFullBackup: jest.fn().mockResolvedValue({
        key: 'private-backups/database/full/pre-restore.json.gz',
      }),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const service = new BackupRestoreService(
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
    process.env.BACKUP_RESTORE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.BACKUP_RESTORE_ENABLED;
  });

  it('恢复确认文本错误时拒绝执行 (400 BadRequest)', async () => {
    const { service } = createService();
    await expect(
      service.restoreBackup(
        'admin',
        'private-backups/database/full/backup.json.gz',
        'WRONG_CONFIRM',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('全量恢复成功：外部租约全程持有，前置快照复用 heldLease，末尾 Fencing 成功并物理清空全部 Checkpoint', async () => {
    const { service, tx, backupService } = createService({ fencingCount: 1 });
    const key = 'private-backups/database/full/backup.json.gz';

    const result = await service.restoreBackup('admin', key, 'CONFIRM_RESTORE');
    expect(result).toBe('数据库还原成功');

    // 1. 验证获取全量全局锁
    expect(backupService.acquireBackupLock).toHaveBeenCalledWith(
      'full',
      'lock:backup:global:full',
      expect.any(String),
    );

    // 2. 验证前置快照复用 heldLease
    expect(backupService.orchestrateFullBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'pre-restore',
        protected: true,
        heldLease: {
          lockKey: 'lock:backup:global:full',
          leaseToken: 'lease_token_full_123',
          owner: 'restore',
        },
      }),
    );

    // 3. 验证事务末尾 CAS fencing 校验
    expect(tx.backupLock.updateMany).toHaveBeenCalledWith({
      where: {
        lockKey: 'lock:backup:global:full',
        leaseToken: 'lease_token_full_123',
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      data: {
        leaseExpiresAt: expect.any(Date),
      },
    });

    // 4. 验证事务内物理清空全部 Checkpoint
    expect(tx.backupModuleCheckpoint.deleteMany).toHaveBeenCalledWith({});

    // 5. 验证锁被释放
    expect(backupService.releaseLock).toHaveBeenCalledWith(
      'lock:backup:global:full',
      'lease_token_full_123',
    );
  });

  it('全量恢复租约失效 (Fencing failed)：事务抛出异常回滚，不删除 Checkpoint，且释放锁', async () => {
    const { service, tx, backupService } = createService({ fencingCount: 0 });
    const key = 'private-backups/database/full/backup.json.gz';

    await expect(service.restoreBackup('admin', key, 'CONFIRM_RESTORE')).rejects.toThrow(
      /恢复期间租约已失效或被接管 \(fencing failed\)，事务回滚/,
    );

    // Checkpoint 物理清空绝不被调用
    expect(tx.backupModuleCheckpoint.deleteMany).not.toHaveBeenCalled();

    // 依然在 finally 中释放锁
    expect(backupService.releaseLock).toHaveBeenCalledWith(
      'lock:backup:global:full',
      'lease_token_full_123',
    );
  });
});
