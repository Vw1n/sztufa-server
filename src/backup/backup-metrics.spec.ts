import { Readable } from 'stream';
import * as zlib from 'zlib';
import { ConflictException } from '@nestjs/common';
import { createV4BackupStream, createV3BackupStream } from './backup-writer';
import { BackupPlan } from './backup-plan.service';
import { BackupExportException } from './backup-export.service';
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
