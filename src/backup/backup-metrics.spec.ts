import { Readable } from 'stream';
import * as zlib from 'zlib';
import { ConflictException } from '@nestjs/common';
import { createV4BackupStream, createV3BackupStream } from './backup-writer';
import { BackupPlan } from './backup-plan.service';
import { BackupExportService, BackupExportException } from './backup-export.service';
import { BackupService } from './backup.service';

async function consumeStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('PR-D Backup Metrics & Traffic Guard Suite', () => {
  describe('三段流量计算与非 ASCII 字符 UTF-8 字节精确累加', () => {
    const plan: BackupPlan = Object.freeze({
      scope: 'module',
      module: 'season',
      selector: Object.freeze({ seasonId: 'season-test' }),
      season: Object.freeze({ id: 'season-test', name: '深圳技术大学联赛' }),
      tables: Object.freeze([
        Object.freeze({
          tableName: 'Season' as const,
          role: 'owned' as const,
          where: {},
          orderBy: { id: 'asc' as const },
        }),
      ]),
      externalDependencies: Object.freeze([]),
    });

    it('准确计算非 ASCII 中文字符 UTF-8 载荷字节与全流未压缩字节', async () => {
      const chineseText = '深圳技术大学足球协会系统2026赛季春季联赛官方技术统计';
      const sampleRow = { id: 'season-1', name: chineseText, description: '测试' };
      const expectedRowJson = JSON.stringify(sampleRow);
      const expectedUtf8Bytes = Buffer.byteLength(expectedRowJson, 'utf8');

      expect(expectedUtf8Bytes).toBeGreaterThan(chineseText.length);

      const result = createV4BackupStream(
        plan,
        async function* (tableName) {
          if (tableName === 'Season') {
            yield [sampleRow];
          } else {
            yield [];
          }
        },
        { createdAt: '2026-09-10T00:00:00.000Z' },
      );

      const compressed = await consumeStream(result.stream);
      const decompressed = zlib.gunzipSync(compressed);
      const metrics = await result.metricsPromise;

      expect(metrics.databaseBytesEstimated).toBe(expectedUtf8Bytes);
      expect(metrics.databaseRowsRead).toBe(1);
      expect(metrics.uncompressedBytes).toBe(decompressed.length);

      const snapshot = result.getMetricsSnapshot();
      expect(snapshot.databaseBytesEstimated).toBe(metrics.databaseBytesEstimated);
      expect(snapshot.databaseRowsRead).toBe(metrics.databaseRowsRead);
      expect(snapshot.uncompressedBytes).toBe(metrics.uncompressedBytes);
    });

    it('V3 格式全量流同样具备精确的三段指标采集与快照导出能力', async () => {
      const rows = [{ id: 'user-1', nickname: '足球协会管理员' }];
      const expectedRowBytes = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8');

      const result = createV3BackupStream(
        (tableName) => {
          return (async function* () {
            if (tableName === 'User') {
              yield rows;
            } else {
              yield [];
            }
          })();
        },
        { scope: 'full' },
      );

      const compressed = await consumeStream(result.stream);
      const decompressed = zlib.gunzipSync(compressed);
      const metrics = await result.metricsPromise;

      expect(metrics.databaseBytesEstimated).toBe(expectedRowBytes);
      expect(metrics.databaseRowsRead).toBe(1);
      expect(metrics.uncompressedBytes).toBe(decompressed.length);
    });
  });

  describe('失败导出真实出口流量计费与预算落账', () => {
    let service: BackupService;
    let mockPrisma: any;
    let mockExportService: any;
    let mockObjectStore: any;
    let mockNeonTrafficService: any;

    beforeEach(() => {
      mockPrisma = {
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'gate-lock' }]),
        backupLock: {
          upsert: jest.fn().mockResolvedValue({ id: 'lock-1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        backupRun: {
          create: jest.fn().mockImplementation(({ data }) => ({
            id: 'run-new-1',
            ...data,
          })),
          upsert: jest.fn().mockImplementation(({ create }) => ({
            id: 'run-upsert-1',
            ...create,
          })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        backupBatch: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
        backupModuleCheckpoint: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({}),
        },
      };

      mockExportService = {
        createBackup: jest.fn(),
      };

      mockObjectStore = {
        deleteObject: jest.fn().mockResolvedValue({}),
        listBackups: jest.fn().mockResolvedValue([]),
      };

      mockNeonTrafficService = {
        fetchMonthlyTraffic: jest.fn().mockResolvedValue({
          status: 'not_configured',
          capturedAt: null,
          billingPeriod: null,
          dataTransferBytes: null,
          allowanceBytes: 5368709120,
          allowanceUsedPercent: null,
          alertLevel: 'unknown',
          stale: false,
        }),
      };

      service = new BackupService(
        mockExportService,
        {} as any,
        {} as any,
        {} as any,
        mockObjectStore,
        {} as any,
        {} as any,
        {} as any,
        mockPrisma,
        {} as any,
        undefined,
        mockNeonTrafficService,
      );
    });

    it('导出阶段读取数据后在上传/校验时失败：必须写入真实出口字节，uploadedBytes 必须为 null', async () => {
      const partialMetrics = {
        databaseBytesEstimated: 450000000,
        uncompressedBytes: 900000000,
        databaseRowsRead: 12000,
        peakRssBytes: 150000000,
      };
      const exportException = new BackupExportException(
        '无法将备份文件保存至对象存储: R2 网络连接超时',
        partialMetrics,
      );
      mockExportService.createBackup.mockRejectedValue(exportException);

      const taskResult = await service.orchestrateModuleBackup({
        username: 'admin',
        module: 'season',
        selector: { seasonId: 'cmr123' },
        purpose: 'manual',
      });

      expect(taskResult.status).toBe('failed');

      expect(mockPrisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            databaseBytesEstimated: BigInt(450000000),
            uncompressedBytes: BigInt(900000000),
            databaseRowsRead: 12000,
            uploadedBytes: null,
            peakRssBytes: BigInt(150000000),
          }),
        }),
      );
    });

    it('上传成功但 R2 HEAD 失败时，返回的 uploadedBytes 严格为 null，绝不以 0 伪装，且持久化记录为 null', async () => {
      mockExportService.createBackup.mockResolvedValue({
        key: 'private-backups/database/module/season/head-fail.json.gz',
        filename: 'head-fail.json.gz',
        size: 0, // 兼容旧字段
        databaseBytesEstimated: 12000,
        uncompressedBytes: 15000,
        uploadedBytes: null, // HEAD 失败，严格为 null
        databaseRowsRead: 30,
        peakRssBytes: 50000000,
      });

      const result = await service.orchestrateModuleBackup({
        username: 'admin',
        module: 'season',
        selector: { seasonId: 'season-head-test' },
        purpose: 'manual',
      });

      expect(result.status).toBe('created');
      if (result.status === 'created') {
        expect(result.backup.uploadedBytes).toBeNull();
        expect(result.backup.size).toBe(0);
      }

      expect(mockPrisma.backupRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'succeeded',
            uploadedBytes: null, // 严格持久化为 null
          }),
        }),
      );
    });

    it('BackupExportService 在上传成功但 headObject 抛异常时，uploadedBytes 设为 null，size 兼容保持 0', async () => {
      const mockPrismaLocal = {
        season: {
          findMany: jest.fn().mockResolvedValue([{ id: 's1', name: '赛季' }]),
        },
      };
      const mockObjectStoreLocal = {
        createUpload: jest.fn().mockReturnValue({
          done: jest.fn().mockResolvedValue(undefined),
          abort: jest.fn().mockResolvedValue(undefined),
        }),
        headObject: jest.fn().mockRejectedValue(new Error('R2 HEAD 500 Network Error')),
        deleteObject: jest.fn().mockResolvedValue({}),
      };
      const mockVerificationService = {
        verifyBackupIntegrity: jest.fn().mockResolvedValue(true),
      };
      const mockAuditLogService = {
        log: jest.fn().mockResolvedValue(true),
      };
      const mockScopeService = {
        getTablesForScope: jest.fn().mockReturnValue(['Season']),
      };
      const mockPlanService = {
        compile: jest.fn().mockResolvedValue({
          scope: 'module',
          module: 'season',
          selector: { seasonId: 's1' },
          tables: [{ tableName: 'Season', role: 'owned', where: {}, orderBy: { id: 'asc' } }],
          externalDependencies: [],
        }),
      };

      const exportService = new BackupExportService(
        mockPrismaLocal as any,
        mockObjectStoreLocal as any,
        mockVerificationService as any,
        mockAuditLogService as any,
        mockScopeService as any,
        mockPlanService as any,
      );

      const metadata = await exportService.createBackup('admin', {
        scope: 'module',
      });

      expect(metadata.size).toBe(0);
      expect(metadata.uploadedBytes).toBeNull();
    });

    it('失败任务消耗的真实出口流量必须计入当月应用出口预算', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-success',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(300 * 1024 * 1024),
          uploadedBytes: BigInt(100 * 1024 * 1024),
          createdAt: new Date(),
        },
        {
          id: 'run-failed',
          status: 'failed',
          databaseBytesEstimated: BigInt(400 * 1024 * 1024),
          uploadedBytes: null,
          createdAt: new Date(),
        },
      ]);

      const dashboard = await service.getDashboard();

      const expectedTotalBytes = BigInt(700 * 1024 * 1024);
      expect(dashboard.applicationBudget.usedBytes).toBe(String(expectedTotalBytes));
      expect(dashboard.storageUploaded.usedBytes).toBe(String(100 * 1024 * 1024));
    });

    it('应用出口预算达到 1.4GB 触发黄色警告，达到 1.6GB 触发红色警告', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-1',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(Math.floor(1.45 * 1024 * 1024 * 1024)),
          uploadedBytes: BigInt(1000),
          createdAt: new Date(),
        },
      ]);

      let dashboard = await service.getDashboard();
      expect(dashboard.applicationBudget.alertLevel).toBe('warning');

      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-2',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(Math.floor(1.65 * 1024 * 1024 * 1024)),
          uploadedBytes: BigInt(1000),
          createdAt: new Date(),
        },
      ]);

      dashboard = await service.getDashboard();
      expect(dashboard.applicationBudget.alertLevel).toBe('critical');
    });
  });

  describe('双维度同口径基线比对与 incomplete 批次标记', () => {
    let service: BackupService;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        backupRun: {
          findMany: jest.fn(),
          findFirst: jest.fn(),
        },
        backupBatch: {
          count: jest.fn(),
        },
      };

      service = new BackupService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        mockPrisma,
        {} as any,
      );
    });

    it('历史全量基线缺失 databaseBytesEstimated 时，判定出口基线不可用，拒绝拿 objectSize 冒充', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          scope: 'module',
          purpose: 'scheduled',
          databaseBytesEstimated: BigInt(50000),
          uncompressedBytes: BigInt(100000),
          uploadedBytes: BigInt(30000),
          status: 'succeeded',
        },
      ]);
      mockPrisma.backupBatch.count.mockResolvedValue(0);

      mockPrisma.backupRun.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
        scope: 'full',
        status: 'succeeded',
        backupKey: 'private-backups/database/full/old.json.gz',
        objectSize: BigInt(200000),
        databaseBytesEstimated: null,
        uploadedBytes: null,
      });

      const summary = await service.getMetricsSummary('2026-09');

      expect(summary.databaseExport.baselineAvailable).toBe(false);
      expect(summary.databaseExport.baselineBytes).toBeNull();
      expect(summary.databaseExport.percentSaved).toBeNull();

      expect(summary.storageUpload.baselineAvailable).toBe(true);
      expect(summary.storageUpload.baselineBytes).toBe('200000');
      expect(summary.storageUpload.savedBytes).toBe(String(200000 - 30000));
    });

    it('当月存在 incomplete 批次时，hasIncompleteBatches 标为 true', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([]);
      mockPrisma.backupRun.findFirst.mockResolvedValue(null);
      mockPrisma.backupBatch.count.mockResolvedValue(1);

      const summary = await service.getMetricsSummary('2026-09');
      expect(summary.hasIncompleteBatches).toBe(true);
    });

    it('当月执行手动全量基线备份时，getMetricsSummary 仅统计 module 范围的当前消耗，不将全量基线计入当前月消耗，正确计算节省率', async () => {
      // 模拟当月包含：1 笔全量基线、1 笔成功模块备份、1 笔 pre-restore 快照、1 笔失败模块备份
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'full-baseline-1',
          scope: 'full',
          purpose: 'manual',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(500000),
          uncompressedBytes: BigInt(600000),
          uploadedBytes: BigInt(150000),
        },
        {
          id: 'module-season-1',
          scope: 'module',
          module: 'season',
          purpose: 'scheduled',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(40000),
          uncompressedBytes: BigInt(50000),
          uploadedBytes: BigInt(10000),
        },
        {
          id: 'pre-restore-1',
          scope: 'module',
          module: 'season',
          purpose: 'pre-restore',
          status: 'succeeded',
          databaseBytesEstimated: BigInt(30000),
          uncompressedBytes: BigInt(35000),
          uploadedBytes: BigInt(8000),
        },
        {
          id: 'module-staff-fail',
          scope: 'module',
          module: 'staff',
          purpose: 'scheduled',
          status: 'failed',
          databaseBytesEstimated: BigInt(10000),
          uncompressedBytes: BigInt(12000),
          uploadedBytes: null,
        },
      ]);
      mockPrisma.backupBatch.count.mockResolvedValue(0);

      // 当月全量基线记录
      mockPrisma.backupRun.findFirst.mockResolvedValueOnce({
        scope: 'full',
        status: 'succeeded',
        backupKey: 'private-backups/database/full/manual-full.json.gz',
        databaseBytesEstimated: BigInt(500000),
        uploadedBytes: BigInt(150000),
      });

      const summary = await service.getMetricsSummary('2026-09');

      // 出口流量：基线 500000，当前仅累计模块（成功 40000 + 失败 10000 = 50000，排除全量 500000 与 pre-restore 30000）
      expect(summary.databaseExport.baselineAvailable).toBe(true);
      expect(summary.databaseExport.baselineBytes).toBe('500000');
      expect(summary.databaseExport.currentBytes).toBe('50000');
      expect(summary.databaseExport.savedBytes).toBe('450000');
      expect(summary.databaseExport.percentSaved).toBe(90);

      // 存储上传：基线 150000，当前仅累计成功模块（10000，排除全量 150000 与 pre-restore 8000 与失败 null）
      expect(summary.storageUpload.baselineAvailable).toBe(true);
      expect(summary.storageUpload.baselineBytes).toBe('150000');
      expect(summary.storageUpload.currentBytes).toBe('10000');
      expect(summary.storageUpload.savedBytes).toBe('140000');
      expect(summary.storageUpload.percentSaved).toBe(93.3);

      // 模块运行总数：仅 2 笔有效目标模块（season成功 + staff失败），排除全量和 pre-restore
      expect(summary.totals.runsCount).toBe(2);
    });
  });

  describe('重试专用互斥锁与批次状态分组重算', () => {
    let service: BackupService;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'gate-lock' }]),
        backupLock: {
          upsert: jest.fn().mockResolvedValue({ id: 'lock-1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        backupRun: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn().mockImplementation(({ data }) => ({ id: 'new-retry-run', ...data })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        backupBatch: {
          update: jest.fn().mockResolvedValue({}),
        },
        backupModuleCheckpoint: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({}),
        },
      };

      const mockExportService = {
        createBackup: jest.fn().mockResolvedValue({
          key: 'private-backups/database/module/season/retry.json.gz',
          size: 1024,
          checksum: 'abc',
          databaseBytesEstimated: 1000,
          uncompressedBytes: 2000,
          uploadedBytes: 1024,
          databaseRowsRead: 10,
          peakRssBytes: 2000000,
        }),
      };

      service = new BackupService(
        mockExportService as any,
        {} as any,
        {} as any,
        {} as any,
        { deleteObject: jest.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        mockPrisma,
        {} as any,
      );
    });

    it('并发双击重试同一失败记录时，第二笔请求被 lock:backup:retry:<runId> 拦截并抛出 409 ConflictException', async () => {
      jest.spyOn(service, 'acquireBackupLock').mockResolvedValueOnce({
        acquired: false,
        reason: 'duplicate_in_flight',
      });

      await expect(service.retryBackupRun('failed-run-1', 'admin')).rejects.toThrow(
        ConflictException,
      );
    });

    it('重试时保留原记录 failed 状态供审计，并创建 trigger: retry 新记录', async () => {
      const originalFailedRun = {
        id: 'failed-run-1',
        module: 'season',
        selectorKey: 'season:cmr123',
        purpose: 'manual',
        status: 'failed',
        scope: 'module',
        attempts: 1,
        batchId: 'batch-1',
      };
      mockPrisma.backupRun.findUnique.mockResolvedValue(originalFailedRun);
      jest.spyOn(service, 'recomputeBatchStatus').mockResolvedValue();

      const result = await service.retryBackupRun('failed-run-1', 'admin');

      expect(result.status).toBe('created');

      expect(mockPrisma.backupRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trigger: 'retry',
            module: 'season',
            attempts: 2,
            batchId: 'batch-1',
          }),
        }),
      );
    });

    it('recomputeBatchStatus 按分组取最新 attempt 重算：部分成功时正确标记为 incomplete（绝非 partial_success）', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-season-1',
          module: 'season',
          selectorKey: 'season:cmr1',
          purpose: 'scheduled',
          status: 'failed',
          createdAt: new Date('2026-09-10T00:00:00Z'),
        },
        {
          id: 'run-season-2',
          module: 'season',
          selectorKey: 'season:cmr1',
          purpose: 'scheduled',
          status: 'succeeded',
          backupKey: 'backup-season.json.gz',
          createdAt: new Date('2026-09-10T00:05:00Z'),
        },
        {
          id: 'run-staff-1',
          module: 'staff',
          selectorKey: 'staff',
          purpose: 'scheduled',
          status: 'failed',
          createdAt: new Date('2026-09-10T00:00:00Z'),
        },
      ]);

      await service.recomputeBatchStatus('batch-1');

      expect(mockPrisma.backupBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'batch-1' },
          data: expect.objectContaining({
            status: 'incomplete',
          }),
        }),
      );
    });

    it('recomputeBatchStatus 全部任务最新 attempt 均成功时更新为 succeeded', async () => {
      mockPrisma.backupRun.findMany.mockResolvedValue([
        {
          id: 'run-season-2',
          module: 'season',
          selectorKey: 'season:cmr1',
          purpose: 'scheduled',
          status: 'succeeded',
          backupKey: 'backup-season.json.gz',
          createdAt: new Date('2026-09-10T00:05:00Z'),
        },
        {
          id: 'run-staff-2',
          module: 'staff',
          selectorKey: 'staff',
          purpose: 'scheduled',
          status: 'succeeded',
          backupKey: 'backup-staff.json.gz',
          createdAt: new Date('2026-09-10T00:05:00Z'),
        },
      ]);

      await service.recomputeBatchStatus('batch-1');

      expect(mockPrisma.backupBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'batch-1' },
          data: expect.objectContaining({
            status: 'succeeded',
          }),
        }),
      );
    });
  });
});
