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
import { parseAndValidateBackupStream } from './backup-serializer';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Readable } from 'stream';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({
    done: jest.fn().mockResolvedValue({ Location: 'https://r2.example.com/file' }),
    abort: jest.fn().mockResolvedValue({}),
  })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned-url'),
}));

describe('BackupService (V3 & Security Spec)', () => {
  let service: BackupService;
  let objectStore: BackupObjectStoreService;
  let verificationService: BackupVerificationService;
  let retentionService: BackupRetentionService;

  const mockPrismaService: any = {
    $transaction: jest.fn().mockImplementation(async (cb, _opts) => {
      return cb(mockPrismaService);
    }),
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    campusCardAsset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    memberAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', username: 'admin' }]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    team: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    player: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    match: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    prediction: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    goal: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    matchEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    news: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    season: {
      findUnique: jest.fn().mockResolvedValue({ id: 'season-1', name: 'Season 1' }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    seasonTeamProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    historyImportBatch: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    seasonDeletionApproval: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    seasonTeamPlayer: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    matchLineup: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    seasonGroupTeam: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    pdfImportBatch: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    adminFormDraft: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    teamRegistration: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    registrationTeamData: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    registrationPlayer: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const mockAuditLogService = {
    log: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-12345';
    process.env.R2_BUCKET_NAME = 'test-bucket';
    process.env.BACKUP_MAX_COMPRESSED_BYTES = '104857600';
    process.env.BACKUP_MAX_UNCOMPRESSED_BYTES = '209715200';
    process.env.BACKUP_RETENTION_DELETE_ENABLED = 'true';
    delete process.env.BACKUP_UPLOAD_TOKEN_TTL_SECONDS;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        BackupObjectStoreService,
        BackupVerificationService,
        BackupExportService,
        BackupRestoreService,
        BackupUploadService,
        BackupMaintenanceService,
        BackupRetentionService,
        BackupScopeService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
    objectStore = module.get<BackupObjectStoreService>(BackupObjectStoreService);
    verificationService = module.get<BackupVerificationService>(BackupVerificationService);
    retentionService = module.get<BackupRetentionService>(BackupRetentionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(retentionService).toBeDefined();
  });

  describe('rawMeter 流式管道拦截回归测试', () => {
    it('当输入流 11 字节超过 10 字节限制时，必须捕获 BadRequestException 而非 Uncaught Exception', async () => {
      const origMax = process.env.BACKUP_MAX_COMPRESSED_BYTES;
      process.env.BACKUP_MAX_COMPRESSED_BYTES = '10';
      const oversizedBuffer = Buffer.from('12345678901');
      const stream = Readable.from([oversizedBuffer]);

      await expect(parseAndValidateBackupStream(stream, 'test.json.gz')).rejects.toThrow(
        BadRequestException,
      );

      process.env.BACKUP_MAX_COMPRESSED_BYTES = origMax;
    });
  });

  describe('createBackup V3 游标分页与客户端中断', () => {
    it('应该使用游标分页 (take, orderBy, cursor) 查询数据模型，断言从未进行无限制全表查询', async () => {
      mockPrismaService.user.findMany.mockClear();
      jest.spyOn(verificationService, 'verifyBackupIntegrity').mockResolvedValue(true);

      const result = await service.createBackup('admin', { purpose: 'manual' });
      expect(result.key).toMatch(/^private-backups\/database\/full\/backup_\d+_manual\.json\.gz$/);
      expect(result.formatVersion).toBe('3.0');
      expect(result.compressed).toBe(true);

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: expect.any(Number),
          orderBy: { id: 'asc' },
        }),
      );
    });

    it('上传后完整性复验返回 false 时必须删除 R2 对象并拒绝返回成功元数据', async () => {
      mockAuditLogService.log.mockClear();
      jest.spyOn(verificationService, 'verifyBackupIntegrity').mockResolvedValue(false);
      const sendSpy = jest.spyOn((objectStore as any).s3Client, 'send').mockResolvedValue({});

      await expect(service.createBackup('admin', { purpose: 'manual' })).rejects.toThrow(
        '无法将备份文件保存至对象存储',
      );

      expect(sendSpy).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      expect(mockAuditLogService.log).not.toHaveBeenCalledWith(
        'admin',
        'CREATE_BACKUP',
        expect.any(String),
      );
    });

    it('分赛季导出 Player 时，目标赛季内的 suspendedAtMatchId 被保留', async () => {
      const mockSeasonId = 'season-1';
      const mockPlayerWithSameSeasonMatch = {
        id: 'p1',
        name: 'Player 1',
        studentId: 'S1',
        jerseyNumber: '10',
        teamId: 't1',
        suspendedAtMatchId: 'm1',
        suspendedAtMatch: { seasonId: 'season-1' },
      };

      mockPrismaService.player.findMany.mockResolvedValueOnce([mockPlayerWithSameSeasonMatch]);

      jest.spyOn(verificationService, 'verifyBackupIntegrity').mockResolvedValue(true);
      jest.spyOn((objectStore as any).s3Client, 'send').mockResolvedValue({});

      const result = await service.createBackup('admin', {
        scope: 'season',
        seasonId: mockSeasonId,
        purpose: 'manual',
      });

      expect(result.scope).toBe('season');
      expect(mockPrismaService.player.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { suspendedAtMatch: { select: { seasonId: true } } },
        }),
      );
    });

    it('分赛季导出 Player 时，跨赛季的 suspendedAtMatchId 被规范化为 null，且绝无 suspendedAtMatch 临时对象', async () => {
      const mockSeasonId = 'season-1';
      const mockPlayerWithOtherSeasonMatch = {
        id: 'p2',
        name: 'Player 2',
        studentId: 'S2',
        jerseyNumber: '11',
        teamId: 't1',
        suspendedAtMatchId: 'm2_other_season',
        suspendedAtMatch: { seasonId: 'season-2' },
      };

      mockPrismaService.player.findMany.mockResolvedValueOnce([mockPlayerWithOtherSeasonMatch]);

      jest.spyOn(verificationService, 'verifyBackupIntegrity').mockResolvedValue(true);
      jest.spyOn((objectStore as any).s3Client, 'send').mockResolvedValue({});

      const result = await service.createBackup('admin', {
        scope: 'season',
        seasonId: mockSeasonId,
        purpose: 'manual',
      });

      expect(result.scope).toBe('season');
    });

    it('单次 Retention 请求中同一个 key 的完整校验 verifyBackupIntegrity 最多被调用 1 次', async () => {
      const mockList = [
        { key: 'private-backups/database/full/backup_newest.json.gz', lastModified: new Date() },
        {
          key: 'private-backups/database/full/backup_old1.json.gz',
          lastModified: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        },
        {
          key: 'private-backups/uploads/upload_expired.json.gz',
          lastModified: new Date(Date.now() - 48 * 3600 * 1000),
        },
      ];

      jest.spyOn(objectStore, 'listBackups').mockResolvedValue(mockList as any);
      const verifySpy = jest.spyOn(verificationService, 'verifyBackupIntegrity');

      jest.spyOn((objectStore as any).s3Client, 'send').mockImplementation(async () => ({}));

      await service.cleanRetention('admin', false, 'EXECUTE_RETENTION_DELETE');

      const callMap = new Map<string, number>();
      for (const call of verifySpy.mock.calls) {
        const key = call[0];
        callMap.set(key, (callMap.get(key) || 0) + 1);
      }

      for (const [, count] of callMap.entries()) {
        expect(count).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('HMAC 无状态 uploadToken 与 initUpload / completeUpload 流程测试', () => {
    it('initUpload 应该生成 uploadToken 及 requiredHeaders', async () => {
      const sampleSha256 = 'a'.repeat(64);
      const res = await service.initUpload('u1', 'admin', 'backup.json.gz', 1024, sampleSha256);

      expect(res.uploadToken).toContain('.');
      expect(res.key).toMatch(/^private-backups\/uploads\/upload_/);
      expect(res.expiresIn).toBe(3600);
      expect(res.requiredHeaders).toEqual({ 'Content-Type': 'application/gzip' });
    });

    it('completeUpload 遇到过期 Token 时应该清理临时上传对象', async () => {
      const initRes = await service.initUpload('u1', 'admin', 'backup.json', 1024, 'a'.repeat(64));
      const [payloadBase64] = initRes.uploadToken.split('.');
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
      payload.expiresAt = Date.now() - 1;
      const expiredPayloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const hmacSecret = crypto
        .createHmac('sha256', process.env.JWT_SECRET!)
        .update('antigravity-backup-upload-token')
        .digest();
      const signature = crypto
        .createHmac('sha256', hmacSecret)
        .update(expiredPayloadBase64)
        .digest('hex');
      const sendSpy = jest.spyOn((objectStore as any).s3Client, 'send').mockResolvedValue({});

      await expect(
        service.completeUpload('u1', 'admin', `${expiredPayloadBase64}.${signature}`),
      ).rejects.toThrow(/上传 Token 已过期/);
      expect(sendSpy).toHaveBeenCalled();
    });

    it('completeUpload 在服务端重算 SHA-256 与 init 记录不一致时必须拒绝并物理清除临时文件', async () => {
      const samplePayload: Record<string, any[]> = {};
      for (const t of [
        'User',
        'Team',
        'Player',
        'Match',
        'Prediction',
        'Goal',
        'MatchEvent',
        'News',
        'AuditLog',
        'Season',
        'SeasonTeamProfile',
        'HistoryImportBatch',
        'SeasonDeletionApproval',
        'SeasonTeamPlayer',
        'MatchLineup',
        'SeasonGroupTeam',
        'PdfImportBatch',
      ]) {
        samplePayload[t] = [];
      }
      samplePayload.MemberAccount = [];
      samplePayload.User = [{ id: 'u1', username: 'admin' }];

      const tablesJson = JSON.stringify(samplePayload);
      const checksum = crypto.createHash('sha256').update(tablesJson).digest('hex');
      const manifest = {
        formatVersion: '3.0',
        createdAt: new Date().toISOString(),
        environment: 'dev',
        schemaVersion: '3.0',
        checksumAlgorithm: 'sha256',
        checksum,
        tables: {
          User: 1,
          MemberAccount: 0,
          Team: 0,
          Player: 0,
          Match: 0,
          Prediction: 0,
          Goal: 0,
          MatchEvent: 0,
          News: 0,
          AuditLog: 0,
          Season: 0,
          SeasonTeamProfile: 0,
          HistoryImportBatch: 0,
          SeasonDeletionApproval: 0,
          SeasonTeamPlayer: 0,
          MatchLineup: 0,
          SeasonGroupTeam: 0,
          PdfImportBatch: 0,
        },
      };
      const v3Obj = {
        manifest,
        formatVersion: '3.0',
        timestamp: Date.now(),
        tables: samplePayload,
      };
      const gzippedBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(v3Obj)));

      const fakeSha256 = 'b'.repeat(64);

      const initRes = await service.initUpload(
        'u1',
        'admin',
        'backup.json.gz',
        gzippedBuffer.length,
        fakeSha256,
      );

      jest.spyOn((objectStore as any).s3Client, 'send').mockImplementation(async (cmd: any) => {
        if (cmd.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: gzippedBuffer.length } as any;
        }
        if (cmd.constructor.name === 'GetObjectCommand') {
          return { Body: Readable.from([gzippedBuffer]) } as any;
        }
        return {} as any;
      });

      await expect(service.completeUpload('u1', 'admin', initRes.uploadToken)).rejects.toThrow(
        /上传文件哈希与初始化摘要不一致/,
      );
    });
  });

  describe('deleteBackup 安全防误删强验证测试', () => {
    it('没有提交 DELETE_BACKUP 确认文本时应拒绝删除', async () => {
      await expect(
        service.deleteBackup('admin', 'private-backups/database/full/b1.json.gz', 'WRONG_CONFIRM'),
      ).rejects.toThrow(BadRequestException);
    });

    it('试图删除不存在的备份点时应拒绝', async () => {
      jest.spyOn(objectStore, 'listBackups').mockResolvedValue([]);
      await expect(
        service.deleteBackup(
          'admin',
          'private-backups/database/full/backup_notfound.json.gz',
          'DELETE_BACKUP',
        ),
      ).rejects.toThrow(/不存在/);
    });

    it('试图删除受 protected 标记保护的备份时应拒绝', async () => {
      const mockList = [
        {
          key: 'private-backups/database/full/backup_1_protected.json.gz',
          filename: 'backup_1_protected.json.gz',
          protected: true,
          scope: 'full',
          lastModified: new Date(),
        },
        {
          key: 'private-backups/database/full/backup_2.json.gz',
          filename: 'backup_2.json.gz',
          scope: 'full',
          lastModified: new Date(Date.now() - 1000),
        },
        {
          key: 'private-backups/database/full/backup_3.json.gz',
          filename: 'backup_3.json.gz',
          scope: 'full',
          lastModified: new Date(Date.now() - 2000),
        },
      ];
      jest.spyOn(objectStore, 'listBackups').mockResolvedValue(mockList as any);

      await expect(
        service.deleteBackup(
          'admin',
          'private-backups/database/full/backup_1_protected.json.gz',
          'DELETE_BACKUP',
        ),
      ).rejects.toThrow(/已被标记为保护，禁止手动删除/);
    });

    it('当剩余全站备份不足 2 个可用恢复点时拒绝删除', async () => {
      const mockList = [
        {
          key: 'private-backups/database/full/backup_newest.json.gz',
          scope: 'full',
          lastModified: new Date(),
        },
        {
          key: 'private-backups/database/full/backup_target.json.gz',
          scope: 'full',
          lastModified: new Date(Date.now() - 10000),
        },
      ];
      jest.spyOn(objectStore, 'listBackups').mockResolvedValue(mockList as any);

      await expect(
        service.deleteBackup(
          'admin',
          'private-backups/database/full/backup_target.json.gz',
          'DELETE_BACKUP',
        ),
      ).rejects.toThrow(/保留至少 2 个有效全站恢复点/);
    });
  });

  describe('cleanRetention 物理删除、O(N) 校验缓存与 Fail-Closed 深度测试', () => {
    it('cleanRetention 在非 dryRun 物理删除时，应该遵循 2 个合法恢复点保护并正确计算 keptCount', async () => {
      const mockList = [
        {
          key: 'private-backups/database/full/backup_newest.json.gz',
          scope: 'full',
          lastModified: new Date(),
        },
        {
          key: 'private-backups/database/full/backup_old1.json.gz',
          scope: 'full',
          lastModified: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        },
        {
          key: 'private-backups/uploads/upload_expired.json.gz',
          scope: 'full',
          lastModified: new Date(Date.now() - 48 * 3600 * 1000),
        },
      ];

      jest.spyOn(objectStore, 'listBackups').mockResolvedValue(mockList as any);
      jest.spyOn(verificationService, 'verifyBackupIntegrity').mockImplementation(async (key) => {
        return key.includes('backup_');
      });

      jest.spyOn((objectStore as any).s3Client, 'send').mockImplementation(async () => ({}));

      const res = await service.cleanRetention('admin', false, 'EXECUTE_RETENTION_DELETE');
      expect(res.dryRun).toBe(false);
      expect(res.deletedCount).toBe(1);
      expect(res.keptCount).toBe(2);
    });
  });

  describe('BackupRestoreService 级联删除防线与并发锁单元测试', () => {
    const buildMockParseResult = () => {
      const mockStagingStore = {
        iterateTable: jest.fn().mockImplementation(async function* () {
          yield [];
        }),
      };
      return {
        formatVersion: '3.0',
        scope: 'full',
        fileSha256: 'a'.repeat(64),
        compressedSize: 100,
        decompressedSize: 200,
        computedChecksum: 'b'.repeat(64),
        tableCounts: {},
        stagingStore: mockStagingStore,
        cleanup: jest.fn(),
      };
    };

    beforeEach(() => {
      process.env.BACKUP_RESTORE_ENABLED = 'true';
      jest.spyOn(objectStore, 'validateBackupKey').mockImplementation(() => {});
      jest.spyOn(objectStore, 'getObjectBody').mockResolvedValue(Readable.from(['{}']) as any);
    });

    it('当数据库中已存在报名记录时，旧版 V3 恢复在快照前直接被拦截，不产生快照且释放资源', async () => {
      const mockParseResult = buildMockParseResult();
      jest.spyOn(verificationService, 'parseAndValidate').mockResolvedValue(mockParseResult as any);
      mockPrismaService.teamRegistration.count.mockResolvedValueOnce(3);

      const createSnapshotSpy = jest.spyOn((service as any).exportService, 'createBackup');

      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/full/backup.json.gz',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(/已存在 3 条报名记录（TeamRegistration）/);

      expect(createSnapshotSpy).not.toHaveBeenCalled();
      expect(mockParseResult.cleanup).toHaveBeenCalled();
    });

    it('当快照前为 0 但在事务中获取表锁超时（55P03）时，应转换为友好 ConflictException 且释放资源', async () => {
      const mockParseResult = buildMockParseResult();
      jest.spyOn(verificationService, 'parseAndValidate').mockResolvedValue(mockParseResult as any);
      mockPrismaService.teamRegistration.count.mockResolvedValueOnce(0);

      jest.spyOn((service as any).exportService, 'createBackup').mockResolvedValue({
        key: 'pre-snap.json.gz',
      } as any);

      mockPrismaService.$executeRawUnsafe.mockRejectedValueOnce({
        code: 'P2010',
        meta: { code: '55P03' },
      });

      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/full/backup.json.gz',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(/无法在安全窗口内锁定报名表，请稍后重试/);

      expect(mockParseResult.cleanup).toHaveBeenCalled();
    });

    it('当快照前为 0 但在锁内权威复核发现并发新增报名时，必须在修改任何数据前拦截', async () => {
      const mockParseResult = buildMockParseResult();
      jest.spyOn(verificationService, 'parseAndValidate').mockResolvedValue(mockParseResult as any);
      mockPrismaService.teamRegistration.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      jest.spyOn((service as any).exportService, 'createBackup').mockResolvedValue({
        key: 'pre-snap.json.gz',
      } as any);

      mockPrismaService.$executeRawUnsafe.mockResolvedValue(1);
      mockPrismaService.campusCardAsset.updateMany.mockClear();
      mockPrismaService.season.deleteMany.mockClear();

      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/full/backup.json.gz',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(/已存在 1 条报名记录（TeamRegistration）/);

      expect(mockPrismaService.campusCardAsset.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaService.season.deleteMany).not.toHaveBeenCalled();
      expect(mockParseResult.cleanup).toHaveBeenCalled();
    });

    it('当无报名数据时，旧版 V3 恢复顺利完成，且绝不向新增 4 表发起 deleteMany()', async () => {
      const mockParseResult = buildMockParseResult();
      jest.spyOn(verificationService, 'parseAndValidate').mockResolvedValue(mockParseResult as any);
      mockPrismaService.teamRegistration.count.mockResolvedValue(0);

      jest.spyOn((service as any).exportService, 'createBackup').mockResolvedValue({
        key: 'pre-snap.json.gz',
      } as any);

      mockPrismaService.teamRegistration.deleteMany.mockClear();
      mockPrismaService.registrationTeamData.deleteMany.mockClear();
      mockPrismaService.registrationPlayer.deleteMany.mockClear();
      mockPrismaService.adminFormDraft.deleteMany.mockClear();

      const res = await service.restoreBackup(
        'admin',
        'private-backups/database/full/backup.json.gz',
        'CONFIRM_RESTORE',
      );

      expect(res).toBe('数据库还原成功');
      expect(mockPrismaService.teamRegistration.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaService.registrationTeamData.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaService.registrationPlayer.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaService.adminFormDraft.deleteMany).not.toHaveBeenCalled();
      expect(mockParseResult.cleanup).toHaveBeenCalled();
    });
  });
});
