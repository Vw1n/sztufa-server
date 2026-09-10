import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupRetentionService } from './backup-retention.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { BackupPlanService } from './backup-plan.service';
import { BackupModuleRestoreService } from './backup-module-restore.service';

describe('BackupService - PR-B Archive Backfill & Protection', () => {
  let service: BackupService;
  let objectStore: jest.Mocked<BackupObjectStoreService>;
  let verificationService: jest.Mocked<BackupVerificationService>;
  let exportService: jest.Mocked<BackupExportService>;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      season: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      backupRun: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      backupLock: {
        create: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({
            lockKey: args?.data?.lockKey || 'season:s1:archive',
            leaseToken: args?.data?.leaseToken || 'default-lease-token',
          }),
        ),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    };

    const mockObjectStore = {
      listBackups: jest.fn().mockResolvedValue([]),
      headObject: jest.fn().mockResolvedValue(1024),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const mockVerificationService = {
      verifyBackupIntegrity: jest.fn().mockResolvedValue(true),
      inspectAndVerifyBackup: jest.fn().mockResolvedValue({
        valid: true,
        checksum: 'sha256-mock-inspected-checksum',
        fileSha256: 'sha256-mock-file',
        compressedSize: 2048,
        decompressedSize: 8192,
      }),
    };

    const mockExportService = {
      createBackup: jest.fn().mockResolvedValue({
        key: 'backups/v4/module/season/backup-season-s1-20260910-120000.sql.gz',
        size: 2048,
        checksum: 'sha256-mock-checksum',
      } as any),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: BackupRetentionService, useValue: {} },
        { provide: BackupScopeService, useValue: {} },
        { provide: BackupObjectStoreService, useValue: mockObjectStore },
        { provide: BackupVerificationService, useValue: mockVerificationService },
        { provide: BackupExportService, useValue: mockExportService },
        { provide: BackupRestoreService, useValue: {} },
        { provide: BackupUploadService, useValue: {} },
        { provide: BackupMaintenanceService, useValue: {} },
        { provide: BackupPlanService, useValue: {} },
        { provide: BackupModuleRestoreService, useValue: {} },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
    objectStore = module.get(BackupObjectStoreService);
    verificationService = module.get(BackupVerificationService);
    exportService = module.get(BackupExportService);
  });

  describe('CAS BackupLock mechanism', () => {
    it('successfully acquires a lock when not held (creates new lock row)', async () => {
      prisma.backupLock.create.mockResolvedValue({
        lockKey: 'season:s1:archive',
        leaseToken: 'new-token',
      });

      const result = await (service as any).acquireLock('season:s1:archive', 'instance-1');
      expect(result.acquired).toBe(true);
      expect(result.leaseToken).toBeDefined();
      expect(prisma.backupLock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lockKey: 'season:s1:archive' }),
        }),
      );
    });

    it('fails to acquire lock when another instance holds an unexpired lease', async () => {
      prisma.backupLock.create.mockRejectedValue({ code: 'P2002' });
      prisma.backupLock.updateMany.mockResolvedValue({ count: 0 });

      const result = await (service as any).acquireLock('season:s1:archive', 'instance-2');
      expect(result.acquired).toBe(false);
      expect(result.leaseToken).toBeUndefined();
    });

    it('allows acquiring lock when previous lease was released (leaseExpiresAt is null)', async () => {
      prisma.backupLock.create.mockRejectedValue({ code: 'P2002' });
      prisma.backupLock.updateMany.mockResolvedValue({ count: 1 });

      const result = await (service as any).acquireLock('season:s1:archive', 'instance-3');
      expect(result.acquired).toBe(true);
      const updateCall = prisma.backupLock.updateMany.mock.calls[0][0];
      expect(updateCall.where.OR).toContainEqual({ leaseExpiresAt: null });
      expect(updateCall.where.OR).toContainEqual({ leaseToken: null });
    });

    it('releases lock by setting leaseToken and leaseExpiresAt to null', async () => {
      prisma.backupLock.updateMany.mockResolvedValue({ count: 1 });

      await (service as any).releaseLock('season:s1:archive', 'test-token');
      expect(prisma.backupLock.updateMany).toHaveBeenCalledWith({
        where: { lockKey: 'season:s1:archive', leaseToken: 'test-token' },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          holderInstance: null,
        },
      });
    });
  });

  describe('Orphan Backup Claiming with Fencing', () => {
    it('claims an existing orphan backup if stream integrity and lock fencing hold', async () => {
      prisma.backupLock.create.mockResolvedValue({
        lockKey: 'season:s1:archive',
        leaseToken: 'lease-s1',
      });
      // Lock is still valid inside transaction
      prisma.backupLock.findFirst.mockResolvedValue({
        lockKey: 'season:s1:archive',
        leaseToken: 'lease-s1',
        leaseExpiresAt: new Date(Date.now() + 60000),
      });
      prisma.backupRun.findUnique.mockResolvedValue(null);
      prisma.backupRun.upsert.mockResolvedValue({});
      prisma.backupRun.updateMany.mockResolvedValue({ count: 1 });

      objectStore.listBackups.mockResolvedValue([
        {
          key: 'backups/v4/module/season/backup-season-s1-legacy.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 5000,
          validated: false,
          checksum: 'sha256-legacy',
        } as any,
      ]);
      objectStore.headObject.mockResolvedValue(5000);
      verificationService.verifyBackupIntegrity.mockResolvedValue(true);

      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('already_protected');
      expect(result.backupKey).toBe('backups/v4/module/season/backup-season-s1-legacy.sql.gz');
      expect(exportService.createBackup).not.toHaveBeenCalled();
      // Must use updateMany with leaseToken
      expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskKey: 'archive:season:s1',
            leaseToken: 'lease-s1',
          }),
          data: expect.objectContaining({
            status: 'succeeded',
            backupKey: 'backups/v4/module/season/backup-season-s1-legacy.sql.gz',
          }),
        }),
      );
    });

    it('rejects orphan claim if lease was hijacked during integrity verification', async () => {
      prisma.backupLock.create.mockRejectedValue({ code: 'P2002' });
      // Lock lost in transaction: CAS updateMany returns count: 0
      prisma.backupLock.updateMany
        .mockResolvedValueOnce({ count: 1 }) // acquireLock
        .mockResolvedValueOnce({ count: 0 }); // fencing transaction CAS updateMany
      prisma.backupRun.findUnique.mockResolvedValue(null);
      prisma.backupRun.upsert.mockResolvedValue({});

      objectStore.listBackups.mockResolvedValue([
        {
          key: 'backups/v4/module/season/backup-season-s1-legacy.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 5000,
        } as any,
      ]);
      objectStore.headObject.mockResolvedValue(5000);
      verificationService.inspectAndVerifyBackup.mockResolvedValue({
        valid: true,
        checksum: 'sha256-legacy',
        fileSha256: 'sha256-legacy',
        compressedSize: 5000,
        decompressedSize: 20000,
      });

      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('孤儿认领前租约已失效或被接管');
    });
    it('evaluates multiple orphan candidates from newest to oldest and claims the valid one even if the first is corrupt', async () => {
      const now = Date.now();
      const corruptKey = 'backups/v4/module/season/backup-season-s1-newest-corrupt.sql.gz';
      const validKey = 'backups/v4/module/season/backup-season-s1-older-valid.sql.gz';

      prisma.backupLock.create.mockResolvedValue({
        lockKey: 'season:s1:archive',
        leaseToken: 'lease-s1',
      });
      prisma.backupRun.findUnique.mockResolvedValue(null);
      prisma.backupRun.upsert.mockResolvedValue({});
      prisma.backupRun.updateMany.mockResolvedValue({ count: 1 });

      objectStore.listBackups.mockResolvedValue([
        {
          key: corruptKey,
          filename: 'backup-season-s1-newest-corrupt.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 4000,
          lastModified: new Date(now), // Newer
        } as any,
        {
          key: validKey,
          filename: 'backup-season-s1-older-valid.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 5000,
          lastModified: new Date(now - 3600 * 1000), // Older
        } as any,
      ]);

      objectStore.headObject.mockImplementation((k: string) =>
        Promise.resolve(k === corruptKey ? 4000 : 5000),
      );

      // corruptKey fails integrity, validKey succeeds
      verificationService.inspectAndVerifyBackup.mockImplementation((k: string) => {
        if (k === corruptKey) {
          return Promise.resolve({ valid: false, error: 'CRC校验和不匹配' });
        }
        return Promise.resolve({
          valid: true,
          checksum: 'sha256-valid-orphan',
          fileSha256: 'sha256-valid-orphan',
          compressedSize: 5000,
          decompressedSize: 20000,
        });
      });

      // 1. Verify scanArchiveCoverage behavior
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季', archivedAt: new Date(), status: 'archived' },
      ]);
      prisma.backupRun.findMany.mockResolvedValue([]);

      const coverage = await service.scanArchiveCoverage();
      expect(coverage.protected).toBe(1);
      expect(coverage.corrupt).toBe(0);
      expect(coverage.seasons[0].hasProtectedBackup).toBe(true);
      expect(coverage.seasons[0].backupKey).toBe(validKey);

      // 2. Verify executeArchiveSeasonBackupWithLock claiming behavior
      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('already_protected');
      expect(result.backupKey).toBe(validKey);
    });

    it('marks season as corrupt with detailed failure reasons when all orphan candidates are invalid', async () => {
      const now = Date.now();
      const corruptKey1 = 'backups/v4/module/season/backup-season-s1-c1.sql.gz';
      const corruptKey2 = 'backups/v4/module/season/backup-season-s1-c2.sql.gz';

      objectStore.listBackups.mockResolvedValue([
        {
          key: corruptKey1,
          filename: 'c1.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 1000,
          lastModified: new Date(now),
        } as any,
        {
          key: corruptKey2,
          filename: 'c2.sql.gz',
          scope: 'module',
          module: 'season',
          seasonId: 's1',
          purpose: 'archive',
          protected: true,
          size: 2000,
          lastModified: new Date(now - 1000),
        } as any,
      ]);

      objectStore.headObject.mockResolvedValue(1000);
      verificationService.inspectAndVerifyBackup.mockResolvedValue({
        valid: false,
        error: '流解析损坏',
      });

      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季', archivedAt: new Date(), status: 'archived' },
      ]);
      prisma.backupRun.findMany.mockResolvedValue([]);

      const coverage = await service.scanArchiveCoverage();
      expect(coverage.protected).toBe(0);
      expect(coverage.corrupt).toBe(1);
      expect(coverage.seasons[0].isCorrupt).toBe(true);
      expect(coverage.seasons[0].lastError).toContain('2 个候选保护备份均校验失败');
    });
  });

  describe('Fencing Guard & Lost Lease Protection', () => {
    it('deletes newly uploaded object and marks run as failed if lock is lost during export', async () => {
      prisma.backupLock.create.mockRejectedValue({ code: 'P2002' });
      prisma.backupRun.findUnique.mockResolvedValue(null);
      prisma.backupRun.upsert.mockResolvedValue({});
      prisma.backupRun.updateMany.mockResolvedValue({ count: 1 });
      objectStore.listBackups.mockResolvedValue([]);

      const uploadedKey = 'backups/v4/module/season/backup-season-s1-temp.sql.gz';
      exportService.createBackup.mockResolvedValue({
        key: uploadedKey,
        size: 1024,
        checksum: 'test-chk',
      } as any);

      // Fencing check inside commit transaction fails (CAS updateMany returns count: 0)
      prisma.backupLock.updateMany
        .mockResolvedValueOnce({ count: 1 }) // acquireLock
        .mockResolvedValueOnce({ count: 0 }); // commit transaction CAS updateMany

      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('fencing check failed');
      expect(objectStore.deleteObject).toHaveBeenCalledWith(uploadedKey);
      expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskKey: 'archive:season:s1',
            leaseToken: expect.any(String),
          }),
          data: expect.objectContaining({
            status: 'failed',
            failureCode: 'ARCHIVE_BACKUP_FAILED',
          }),
        }),
      );
    });

    it('prevents old expired holder from overwriting new holder succeeded state on catch', async () => {
      prisma.backupLock.create.mockResolvedValue({
        lockKey: 'season:s1:archive',
        leaseToken: 'old-expired-token',
      });
      prisma.backupRun.findUnique.mockResolvedValue(null);
      prisma.backupRun.upsert.mockResolvedValue({});

      // Export fails with timeout
      exportService.createBackup.mockRejectedValue(new Error('Export timed out'));

      // In the meantime, new instance hijacked the task, so updateMany where taskKey and old token matches 0 rows
      prisma.backupRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');

      expect(result.status).toBe('failed');
      // Verify the query strictly scoped to old leaseToken so new holder's succeeded status is untouched
      expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            taskKey: 'archive:season:s1',
            leaseToken: 'old-expired-token',
          },
        }),
      );
    });
  });

  describe('Archive Backfill Preview & Execution Token Verification', () => {
    it('signs HMAC token and returns affected tables without pre-reading row counts', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季联赛', archivedAt: new Date(), status: 'archived' },
      ]);
      prisma.backupRun.findFirst.mockResolvedValue(null);
      objectStore.listBackups.mockResolvedValue([]);

      const preview = await service.previewArchiveBackfill('operator-123', ['s1']);

      expect(preview.missingSeasons).toHaveLength(1);
      expect(preview.missingSeasons[0].id).toBe('s1');
      expect(preview.estimatedRows).toBeNull();
      expect(preview.estimatedBytes).toBeNull();
      expect(preview.backfillToken).toBeDefined();
      expect(preview.affectedTables.length).toBeGreaterThan(0);
    });

    it('rejects execute request if token operator does not match', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季联赛', archivedAt: new Date(), status: 'archived' },
      ]);
      prisma.backupRun.findFirst.mockResolvedValue(null);
      objectStore.listBackups.mockResolvedValue([]);

      const preview = await service.previewArchiveBackfill('operator-1', ['s1']);

      await expect(
        service.executeArchiveBackfill('operator-2', 'operator-2', preview.backfillToken, ['s1']),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects execute request if seasonIds exceed maximum 10 seasons', async () => {
      const elevenSeasons = Array.from({ length: 11 }, (_, i) => `s-${i}`);
      const validTokenForEleven = (service as any).generateBackfillToken('operator-1', elevenSeasons);

      await expect(
        service.executeArchiveBackfill('operator-1', 'operator-1', validTokenForEleven, elevenSeasons),
      ).rejects.toThrow('单次补建赛季数量超过最大上限');
    });
  });

  describe('Coverage Scan: Strict Size Check & Backoff Logic', () => {
    it('marks succeeded backup as corrupt if HEAD size does not match recorded objectSize', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季', archivedAt: new Date(), status: 'archived' },
      ]);
      // Recorded size is 2048
      prisma.backupRun.findMany.mockResolvedValue([
        {
          selectorKey: 'season:s1',
          purpose: 'archive',
          status: 'succeeded',
          backupKey: 'backups/v4/module/season/backup.sql.gz',
          checksum: 'sha256-valid',
          objectSize: BigInt(2048),
        },
      ]);
      // Cloud object was truncated to 1024 bytes
      objectStore.headObject.mockResolvedValue(1024);

      const coverage = await service.scanArchiveCoverage();

      expect(coverage.protected).toBe(0);
      expect(coverage.corrupt).toBe(1);
      expect(coverage.seasons[0].isCorrupt).toBe(true);
      expect(coverage.seasons[0].hasProtectedBackup).toBe(false);
      expect(coverage.seasons[0].lastError).toContain('大小不匹配');
    });

    it('falls back to stream verification when succeeded record lacks checksum or objectSize', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季', archivedAt: new Date(), status: 'archived' },
      ]);
      // Old succeeded record without checksum
      prisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-legacy',
          selectorKey: 'season:s1',
          purpose: 'archive',
          status: 'succeeded',
          backupKey: 'backups/v4/module/season/legacy.sql.gz',
          checksum: null,
          objectSize: null,
        },
      ]);
      objectStore.headObject.mockResolvedValue(2048);
      verificationService.inspectAndVerifyBackup.mockResolvedValue({
        valid: true,
        checksum: 'sha256-legacy-inspected',
        fileSha256: 'sha256-legacy-file',
        compressedSize: 2048,
        decompressedSize: 8192,
      });

      const coverage = await service.scanArchiveCoverage();

      expect(coverage.protected).toBe(1);
      expect(coverage.corrupt).toBe(0);
      expect(coverage.seasons[0].hasProtectedBackup).toBe(true);
      expect(verificationService.inspectAndVerifyBackup).toHaveBeenCalledWith('backups/v4/module/season/legacy.sql.gz');
      // Backfills objectSize and checksum into BackupRun
      expect(prisma.backupRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-legacy' },
          data: expect.objectContaining({
            checksum: 'sha256-legacy-inspected',
            objectSize: BigInt(2048),
          }),
        }),
      );
    });

    it('skips seasons currently backing off in executeArchiveBackfill', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024秋季', archivedAt: new Date(), status: 'archived' },
      ]);
      prisma.backupRun.findFirst.mockResolvedValue(null);
      objectStore.listBackups.mockResolvedValue([]);

      const preview = await service.previewArchiveBackfill('op-1', ['s1']);

      prisma.season.findUnique.mockResolvedValue({
        id: 's1',
        name: '2024秋季',
        status: 'archived',
      });
      // Previous run failed and still in backoff window
      prisma.backupRun.findFirst.mockResolvedValue({
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes in future
      } as any);

      const result = await service.executeArchiveBackfill('op-1', 'op-1', preview.backfillToken, ['s1']);

      expect(result.skipped).toBe(1);
      expect(result.items[0].status).toBe('skipped');
      expect(result.items[0].reason).toBe('backing_off');
    });

    it('rejects single-season retryArchiveSeasonBackfill when season is in backoff cooldown', async () => {
      prisma.season.findUnique.mockResolvedValue({
        id: 's1',
        name: '2024秋季',
        status: 'archived',
      });
      prisma.backupRun.findFirst.mockResolvedValue({
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + 300 * 1000), // 300 seconds in future
      } as any);

      await expect(
        service.retryArchiveSeasonBackfill('s1', 'admin'),
      ).rejects.toThrow('当前赛季归档备份处于退避重试冷却期');
    });

    it('skips execution in executeArchiveSeasonBackupWithLock when in backoff window', async () => {
      prisma.backupRun.findFirst.mockResolvedValue({
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + 60 * 1000),
      } as any);

      const result = await service.executeArchiveSeasonBackupWithLock('admin', 's1', 'backfill');
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('backing_off');
    });
  });

  describe('Security Constraints on Archive Backup Creation', () => {
    const createExportService = () =>
      new BackupExportService(
        prisma,
        objectStore,
        verificationService,
        {} as any,
        {} as any,
        {} as any,
      );

    it('rejects archive backup on active seasons', async () => {
      prisma.season.findUnique.mockResolvedValue({ id: 's-active', status: 'active' });
      const actualExportService = createExportService();

      await expect(
        actualExportService.createBackup('admin', {
          scope: 'module',
          module: 'season',
          selector: { seasonId: 's-active' },
          purpose: 'archive',
          protected: true,
        }),
      ).rejects.toThrow('仅状态为已归档 (archived) 的赛季允许创建归档保护备份');
    });

    it('rejects archive backup on non-season modules', async () => {
      const actualExportService = createExportService();

      await expect(
        actualExportService.createBackup('admin', {
          scope: 'module',
          module: 'staff',
          selector: {},
          purpose: 'archive',
          protected: true,
        }),
      ).rejects.toThrow('归档保护备份仅允许在 scope="module" 且 module="season" 时创建');
    });

    it('rejects mismatch between purpose=archive and protected flag', async () => {
      const actualExportService = createExportService();

      // purpose=archive but protected=false
      await expect(
        actualExportService.createBackup('admin', {
          scope: 'module',
          module: 'season',
          selector: { seasonId: 's1' },
          purpose: 'archive',
          protected: false,
        }),
      ).rejects.toThrow('归档保护备份必须同时满足 purpose="archive" 且 protected=true');

      // purpose=manual but protected=true
      await expect(
        actualExportService.createBackup('admin', {
          scope: 'full',
          purpose: 'manual',
          protected: true,
        }),
      ).rejects.toThrow('仅 purpose="archive" 或 purpose="pre-restore" 允许设置受保护标记');
    });

    it('allows purpose=pre-restore with protected=true without requiring archived season check', async () => {
      const planService = {
        compile: jest.fn().mockResolvedValue({
          scope: 'module',
          module: 'staff',
          selector: {},
          tables: [],
          externalDependencies: [],
        }),
      };
      const mockAuditLog = { log: jest.fn().mockResolvedValue(undefined) };
      const mockObjectStore = {
        createUpload: jest.fn().mockReturnValue({
          done: jest.fn().mockResolvedValue(undefined),
          abort: jest.fn().mockResolvedValue(undefined),
        }),
        headObject: jest.fn().mockResolvedValue(1024),
        deleteObject: jest.fn().mockResolvedValue(undefined),
      };
      const mockVerification = {
        verifyBackupIntegrity: jest.fn().mockResolvedValue(true),
      };

      const actualExportService = new BackupExportService(
        prisma,
        mockObjectStore as any,
        mockVerification as any,
        mockAuditLog as any,
        {} as any,
        planService as any,
      );

      const result = await actualExportService.createBackup('admin', {
        scope: 'module',
        module: 'staff',
        selector: {},
        purpose: 'pre-restore',
        protected: true,
      });

      expect(result).toBeDefined();
      expect(result.purpose).toBe('pre-restore');
      expect(result.protected).toBe(true);
      expect(mockObjectStore.createUpload).toHaveBeenCalled();
    });
  });

  describe('scanArchiveCoverage - checksum backfill verification', () => {
    it('populates checksum into BackupRun when verifying legacy backup missing checksum', async () => {
      prisma.season.findMany.mockResolvedValue([
        { id: 's1', name: '2024 Fall', status: 'archived', archivedAt: new Date() },
      ]);
      prisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-1',
          selectorKey: 'season:s1',
          taskKey: 'archive:season:s1',
          status: 'succeeded',
          backupKey: 'backups/v4/module/season/backup-season-s1.sql.gz',
          checksum: null, // missing checksum
          objectSize: null,
          verifiedAt: null,
        },
      ]);
      objectStore.headObject.mockResolvedValue(2048);

      const res = await service.scanArchiveCoverage();

      expect(res.protected).toBe(1);
      expect(verificationService.inspectAndVerifyBackup).toHaveBeenCalledWith(
        'backups/v4/module/season/backup-season-s1.sql.gz',
      );
      expect(prisma.backupRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          checksum: 'sha256-mock-inspected-checksum',
          objectSize: BigInt(2048),
          verifiedAt: expect.any(Date),
        },
      });
    });
  });
});
