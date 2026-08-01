import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupRetentionService } from './backup-retention.service';
import { parseAndValidateBackupStream } from './backup-serializer';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Readable } from 'stream';

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({
    done: jest.fn().mockResolvedValue({ Location: 'https://r2.example.com/file' }),
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
    season: { findMany: jest.fn().mockResolvedValue([]) },
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        BackupRetentionService,
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

      await expect(
        parseAndValidateBackupStream(stream, 'test.json.gz'),
      ).rejects.toThrow(BadRequestException);

      process.env.BACKUP_MAX_COMPRESSED_BYTES = origMax;
    });
  });

  describe('createBackup V3', () => {
    it('应该查询全部 17 个模型并流式生成 V3 .json.gz 备份', async () => {
      const result = await service.createBackup('admin', { purpose: 'manual' });
      expect(result.key).toMatch(/^private-backups\/database\/backup_\d+_manual\.json\.gz$/);
      expect(result.formatVersion).toBe('3.0');
      expect(result.compressed).toBe(true);
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        'admin',
        'CREATE_BACKUP',
        expect.stringContaining('V3.0 GZIP'),
      );
    });
  });

  describe('HMAC 无状态 uploadToken 与 initUpload / completeUpload 流程测试', () => {
    it('initUpload 应该生成 uploadToken 及 requiredHeaders', async () => {
      const sampleSha256 = 'a'.repeat(64);
      const res = await service.initUpload('u1', 'admin', 'backup.json.gz', 1024, sampleSha256);

      expect(res.uploadToken).toContain('.');
      expect(res.key).toMatch(/^private-backups\/uploads\/upload_/);
      expect(res.requiredHeaders).toEqual({ 'Content-Type': 'application/gzip' });
    });

    it('completeUpload 在服务端重算 SHA-256 与 init 记录不一致时必须拒绝并物理清除临时文件', async () => {
      const samplePayload = {
        User: [{ id: 'u1', username: 'admin' }],
        Team: [], Player: [], Match: [], Prediction: [], Goal: [], MatchEvent: [],
        News: [], AuditLog: [], Season: [], SeasonTeamProfile: [], HistoryImportBatch: [],
        SeasonDeletionApproval: [], SeasonTeamPlayer: [], MatchLineup: [], SeasonGroupTeam: [], PdfImportBatch: []
      };
      const tablesJson = JSON.stringify(samplePayload);
      const checksum = crypto.createHash('sha256').update(tablesJson).digest('hex');
      const manifest = {
        formatVersion: '3.0', createdAt: new Date().toISOString(), environment: 'dev',
        schemaVersion: '3.0', checksumAlgorithm: 'sha256', checksum, tables: { User: 1, Team: 0, Player: 0, Match: 0, Prediction: 0, Goal: 0, MatchEvent: 0, News: 0, AuditLog: 0, Season: 0, SeasonTeamProfile: 0, HistoryImportBatch: 0, SeasonDeletionApproval: 0, SeasonTeamPlayer: 0, MatchLineup: 0, SeasonGroupTeam: 0, PdfImportBatch: 0 }
      };
      const v3Obj = { manifest, formatVersion: '3.0', timestamp: Date.now(), tables: samplePayload };
      const gzippedBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(v3Obj)));

      const fakeSha256 = 'b'.repeat(64);

      const initRes = await service.initUpload('u1', 'admin', 'backup.json.gz', gzippedBuffer.length, fakeSha256);

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
    it('没有提交 CONFIRM_DELETE 确认文本时应拒绝删除', async () => {
      await expect(
        service.deleteBackup('admin', 'private-backups/database/b1.json.gz', 'WRONG_CONFIRM'),
      ).rejects.toThrow(BadRequestException);
    });

    it('当剩余备份不足 2 个可用恢复点时拒绝删除', async () => {
      const mockList = [
        { key: 'private-backups/database/backup_newest.json.gz', lastModified: new Date() },
        { key: 'private-backups/database/backup_target.json.gz', lastModified: new Date(Date.now() - 10000) },
      ];
      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);

      await expect(
        service.deleteBackup('admin', 'private-backups/database/backup_target.json.gz', 'DELETE_BACKUP'),
      ).rejects.toThrow(/保留至少 2 个有效恢复点/);
    });
  });

  describe('cleanRetention 物理删除、O(N) 校验缓存与 Fail-Closed 深度测试', () => {
    it('cleanRetention 在非 dryRun 物理删除时，应该遵循 2 个合法恢复点保护并正确计算 keptCount', async () => {
      const mockList = [
        { key: 'private-backups/database/backup_newest.json.gz', lastModified: new Date() },
        { key: 'private-backups/database/backup_old1.json.gz', lastModified: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
        { key: 'private-backups/uploads/upload_expired.json.gz', lastModified: new Date(Date.now() - 48 * 3600 * 1000) },
      ];

      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);
      jest.spyOn(service, 'verifyBackupIntegrity').mockImplementation(async (key) => {
        return key.includes('backup_');
      });

      jest.spyOn((service as any).s3Client, 'send').mockImplementation(async () => {
        return {} as any;
      });

      const res = await service.cleanRetention('admin', false, 'EXECUTE_RETENTION_DELETE');
      expect(res.dryRun).toBe(false);
      expect(res.deletedCount).toBe(1);
      expect(res.keptCount).toBe(2);
    });

    it('回归测试：当 validDbCount=1 且待删数据库备份已损坏(isItemValid=false)时，绝不能删除该数据库备份', async () => {
      const mockList = [
        { key: 'private-backups/database/backup_newest.json.gz', lastModified: new Date() },
        { key: 'private-backups/database/backup_corrupt.json.gz', lastModified: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      ];

      jest.spyOn(service, 'listBackups').mockResolvedValue(mockList as any);
      jest.spyOn(service, 'verifyBackupIntegrity').mockImplementation(async (key) => {
        return key.includes('backup_newest');
      });

      const deleteCmdSpy = jest.spyOn((service as any).s3Client, 'send').mockImplementation(async () => {
        return {} as any;
      });

      const res = await service.cleanRetention('admin', false, 'EXECUTE_RETENTION_DELETE');
      expect(res.deletedCount).toBe(0);

      const dbDeletions = deleteCmdSpy.mock.calls.filter(([cmd]: any[]) =>
        cmd?.constructor?.name === 'DeleteObjectCommand' && (cmd?.input?.Key || '').includes('database/'),
      );
      expect(dbDeletions.length).toBe(0);
    });

    it('当 R2 列表分页令牌失效或遭遇死循环时，必须抛出 ServiceUnavailableException Fail-Closed 拦截', async () => {
      jest.spyOn((service as any).s3Client, 'send').mockImplementation(async (cmd: any) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return {
            IsTruncated: true,
            Contents: [{ Key: 'private-backups/database/b1.json.gz' }],
            NextContinuationToken: undefined,
          } as any;
        }
        return {} as any;
      });

      await expect(service.listBackups()).rejects.toThrow(
        /R2 列表分页令牌失效或遭遇循环引用/,
      );
    });
  });
});
