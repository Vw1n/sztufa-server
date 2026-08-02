import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupRetentionService } from './backup-retention.service';
import { BackupScopeService } from './backup-scope.service';
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
  let retentionService: BackupRetentionService;

  const mockPrismaService = {
    $transaction: jest.fn().mockImplementation(async (cb) => {
      return cb(mockPrismaService);
    }),
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', username: 'admin' }]) },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    player: { findMany: jest.fn().mockResolvedValue([]) },
    match: { findMany: jest.fn().mockResolvedValue([]) },
    prediction: { findMany: jest.fn().mockResolvedValue([]) },
    goal: { findMany: jest.fn().mockResolvedValue([]) },
    matchEvent: { findMany: jest.fn().mockResolvedValue([]) },
    news: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    season: {
      findUnique: jest.fn().mockResolvedValue({ id: 'season-1', name: 'Season 1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    seasonTeamProfile: { findMany: jest.fn().mockResolvedValue([]) },
    historyImportBatch: { findMany: jest.fn().mockResolvedValue([]) },
    seasonDeletionApproval: { findMany: jest.fn().mockResolvedValue([]) },
    seasonTeamPlayer: { findMany: jest.fn().mockResolvedValue([]) },
    matchLineup: { findMany: jest.fn().mockResolvedValue([]) },
    seasonGroupTeam: { findMany: jest.fn().mockResolvedValue([]) },
    pdfImportBatch: { findMany: jest.fn().mockResolvedValue([]) },
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
        BackupRetentionService,
        BackupScopeService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
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
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);

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
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(false);
      const sendSpy = jest.spyOn((service as any).s3Client, 'send').mockResolvedValue({});

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

      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);
      jest.spyOn((service as any).s3Client, 'send').mockResolvedValue({});

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

      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);
      jest.spyOn((service as any).s3Client, 'send').mockResolvedValue({});

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

      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);
      const verifySpy = jest.spyOn(service, 'verifyBackupIntegrity');

      jest.spyOn((service as any).s3Client, 'send').mockImplementation(async () => ({}));

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
      const sendSpy = jest.spyOn((service as any).s3Client, 'send').mockResolvedValue({});

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

      jest.spyOn((service as any).s3Client, 'send').mockImplementation(async (cmd: any) => {
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
      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);

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

      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);
      jest.spyOn(service, 'verifyBackupIntegrity').mockImplementation(async (key) => {
        return key.includes('backup_');
      });

      jest.spyOn((service as any).s3Client, 'send').mockImplementation(async () => ({}));

      const res = await service.cleanRetention('admin', false, 'EXECUTE_RETENTION_DELETE');
      expect(res.dryRun).toBe(false);
      expect(res.deletedCount).toBe(1);
      expect(res.keptCount).toBe(2);
    });
  });
});
