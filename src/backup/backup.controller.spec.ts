import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { BackupController } from './backup.controller';

import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter } from 'events';

describe('BackupController Supertest HTTP Guard & Roles Spec', () => {
  let app: INestApplication;
  let mockBackupService: any;
  let jwtService: JwtService;

  const superAdminToken = 'Bearer valid_super_admin_token';
  const adminToken = 'Bearer valid_admin_token';
  const coachToken = 'Bearer valid_coach_token';

  beforeEach(async () => {
    mockBackupService = {
      createBackup: jest
        .fn()
        .mockResolvedValue({ key: 'private-backups/database/backup_123.json.gz' }),
      createScheduledBackup: jest
        .fn()
        .mockResolvedValue({ key: 'private-backups/database/backup_scheduled.json.gz' }),
      createScheduledBackupBatch: jest.fn().mockResolvedValue({
        batchId: 'batch_test',
        periodKey: '2026-09',
        status: 'succeeded',
        succeeded: 5,
        skipped: 0,
        failed: 0,
        items: [],
      }),
      listBackupBatches: jest
        .fn()
        .mockResolvedValue([{ id: 'batch_1', periodKey: '2026-09', status: 'incomplete' }]),
      getBackupBatch: jest.fn().mockResolvedValue({
        id: 'batch_1',
        periodKey: '2026-09',
        status: 'incomplete',
        items: [],
      }),
      retryScheduledBackupBatch: jest.fn().mockResolvedValue({
        batchId: 'batch_1',
        periodKey: '2026-09',
        status: 'succeeded',
        succeeded: 5,
        skipped: 0,
        failed: 0,
        items: [],
      }),
      listBackupRuns: jest.fn().mockResolvedValue({
        total: 1,
        limit: 20,
        offset: 0,
        items: [
          {
            id: 'run-1',
            module: 'staff',
            status: 'succeeded',
            objectSize: '1024',
            databaseBytesEstimated: '5000',
            uncompressedBytes: '10000',
            uploadedBytes: '1024',
            peakRssBytes: '2048000',
          },
        ],
      }),
      listBackupCheckpoints: jest.fn().mockResolvedValue([
        {
          id: 'cp-1',
          module: 'staff',
          selectorKey: 'staff',
          fingerprint: 'abc',
        },
      ]),
      listBackups: jest.fn().mockResolvedValue([]),
      getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.example.com/url'),
      restoreBackup: jest.fn().mockResolvedValue('数据库还原成功'),
      initUpload: jest.fn().mockResolvedValue({
        uploadToken: 'token.sig',
        uploadUrl: 'url',
        requiredHeaders: { 'Content-Type': 'application/gzip' },
      }),
      completeUpload: jest
        .fn()
        .mockResolvedValue({ key: 'private-backups/database/backup_uploaded.json.gz' }),
      deleteBackup: jest.fn().mockResolvedValue('备份删除成功'),
      cleanRetention: jest.fn().mockResolvedValue({ dryRun: true, plannedDeletions: [] }),
      getDashboard: jest.fn().mockResolvedValue({
        applicationBudget: { usedBytes: '1000' },
        neonOfficial: { status: 'not_configured' },
      }),
      getMetricsSummary: jest.fn().mockResolvedValue({ periodKey: '2026-09' }),
      getMetricsTimeseries: jest.fn().mockResolvedValue([]),
      retryBackupRun: jest.fn().mockResolvedValue({ status: 'created' }),
    };

    jwtService = new JwtService({ secret: 'test-secret' });

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        Reflector,
        { provide: BackupService, useValue: mockBackupService },
        { provide: JwtService, useValue: jwtService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const auth = req.headers['authorization'];
          if (!auth) return false;
          if (auth === superAdminToken) {
            req.user = { id: 'u_admin', username: 'admin', role: 'super_admin' };
            return true;
          }
          if (auth === adminToken) {
            req.user = { id: 'u_admin2', username: 'admin2', role: 'admin' };
            return true;
          }
          if (auth === coachToken) {
            req.user = { id: 'u_coach', username: 'coach_john', role: 'coach' };
            return true;
          }
          return false;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('未提供 JWT 凭证时访问备份接口应返回 403 / 401 拒绝对话', async () => {
    await request(app.getHttpServer()).post('/api/v1/backups/create').expect(403);
    await request(app.getHttpServer()).get('/api/v1/backups/list').expect(403);
    await request(app.getHttpServer()).get('/api/v1/backups/batches').expect(403);
    await request(app.getHttpServer()).get('/api/v1/backups/batches/batch_1').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/batches/batch_1/retry').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/upload/init').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/upload/complete').expect(403);
    await request(app.getHttpServer()).delete('/api/v1/backups').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/retention/clean').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/restore').expect(403);
    await request(app.getHttpServer()).get('/api/v1/backups/runs').expect(403);
    await request(app.getHttpServer()).get('/api/v1/backups/checkpoints').expect(403);
  });

  it('普通教练身份 (coach) 访问备份受控 API 应当返回 403 Forbidden 拦截', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backups/create')
      .set('Authorization', coachToken)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/backups/batches')
      .set('Authorization', coachToken)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs')
      .set('Authorization', coachToken)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/backups/checkpoints')
      .set('Authorization', coachToken)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/backups/batches/batch_1/retry')
      .set('Authorization', coachToken)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/backups/upload/init')
      .set('Authorization', coachToken)
      .send({ filename: 'b.json.gz', size: 100, sha256: 'a'.repeat(64) })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/backups/upload/complete')
      .set('Authorization', coachToken)
      .send({ uploadToken: 't.s' })
      .expect(403);

    await request(app.getHttpServer())
      .delete('/api/v1/backups')
      .set('Authorization', coachToken)
      .send({ key: 'private-backups/database/b.json.gz', confirmText: 'DELETE_BACKUP' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/backups/retention/clean')
      .set('Authorization', coachToken)
      .expect(403);
  });

  it('超级管理员 (super_admin) 访问批次查询与重试 API 应当成功通过 (200 / 201 OK)', async () => {
    mockBackupService.listBackupBatches.mockResolvedValueOnce({
      total: 1,
      limit: 20,
      offset: 0,
      items: [{ id: 'batch_1', periodKey: '2026-09', status: 'incomplete' }],
    });

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/backups/batches?status=incomplete&limit=20&offset=0')
      .set('Authorization', superAdminToken)
      .expect(200);
    expect(listRes.body.data.items[0].id).toBe('batch_1');
    expect(listRes.body.data.total).toBe(1);

    const detailRes = await request(app.getHttpServer())
      .get('/api/v1/backups/batches/batch_1')
      .set('Authorization', superAdminToken)
      .expect(200);
    expect(detailRes.body.data.id).toBe('batch_1');

    const retryRes = await request(app.getHttpServer())
      .post('/api/v1/backups/batches/batch_1/retry')
      .set('Authorization', superAdminToken)
      .expect(201);
    expect(retryRes.body.data.status).toBe('succeeded');
  });

  it('批次列表查询参数非法时返回 400 校验错误', async () => {
    // 1. limit 为非法字符 (如 2abc)
    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?limit=2abc')
      .set('Authorization', superAdminToken)
      .expect(400);

    // 2. limit 超出范围 (如 0 或 101)
    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?limit=0')
      .set('Authorization', superAdminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?limit=101')
      .set('Authorization', superAdminToken)
      .expect(400);

    // 3. offset 为负数
    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?offset=-1')
      .set('Authorization', superAdminToken)
      .expect(400);

    // 4. periodKey 格式非法 (如 2026-99)
    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?periodKey=2026-99')
      .set('Authorization', superAdminToken)
      .expect(400);

    // 5. status 非法
    await request(app.getHttpServer())
      .get('/api/v1/backups/batches?status=invalid_status')
      .set('Authorization', superAdminToken)
      .expect(400);
  });

  it('管理员 (admin) 与超级管理员 (super_admin) 访问 runs 与 checkpoints API 应当成功 (200 OK)', async () => {
    const runsRes = await request(app.getHttpServer())
      .get('/api/v1/backups/runs?module=staff&status=succeeded&limit=10&offset=0')
      .set('Authorization', adminToken)
      .expect(200);

    expect(mockBackupService.listBackupRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'staff',
        status: 'succeeded',
        limit: 10,
        offset: 0,
      }),
    );
    expect(runsRes.body.success).toBe(true);
    expect(runsRes.body.data.items[0].databaseBytesEstimated).toBe('5000');
    expect(runsRes.body.data.items[0].objectSize).toBe('1024');

    const cpRes = await request(app.getHttpServer())
      .get('/api/v1/backups/checkpoints?module=staff')
      .set('Authorization', superAdminToken)
      .expect(200);

    expect(mockBackupService.listBackupCheckpoints).toHaveBeenCalledWith({
      module: 'staff',
      selectorKey: undefined,
    });
    expect(cpRes.body.success).toBe(true);
    expect(cpRes.body.data[0].fingerprint).toBe('abc');
  });

  it('runs 列表查询参数非法时返回 400 校验错误', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?limit=0')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?limit=101')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?limit=invalid')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?offset=-1')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?module=invalid_module')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?status=invalid_status')
      .set('Authorization', adminToken)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/backups/runs?trigger=invalid_trigger')
      .set('Authorization', adminToken)
      .expect(400);
  });

  it('GET /api/v1/backups/dashboard 权限测试: admin 及 super_admin 可访问，coach 返回 403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backups/dashboard')
      .set('Authorization', adminToken)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/backups/dashboard')
      .set('Authorization', superAdminToken)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/backups/dashboard')
      .set('Authorization', coachToken)
      .expect(403);
  });

  it('GET /api/v1/backups/metrics/summary 权限与参数透传测试', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backups/metrics/summary?periodKey=2026-09')
      .set('Authorization', adminToken)
      .expect(200);

    expect(mockBackupService.getMetricsSummary).toHaveBeenCalledWith('2026-09');
  });

  it('GET /api/v1/backups/metrics/timeseries 权限与参数透传测试', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backups/metrics/timeseries?months=12')
      .set('Authorization', adminToken)
      .expect(200);

    expect(mockBackupService.getMetricsTimeseries).toHaveBeenCalledWith(12);
  });

  it('POST /api/v1/backups/runs/:runId/retry: super_admin 可执行，admin 返回 403', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backups/runs/run-failed-1/retry')
      .set('Authorization', superAdminToken)
      .expect(201);

    expect(mockBackupService.retryBackupRun).toHaveBeenCalledWith('run-failed-1', 'admin');

    await request(app.getHttpServer())
      .post('/api/v1/backups/runs/run-failed-1/retry')
      .set('Authorization', adminToken)
      .expect(403);
  });
});

describe('BackupController scheduled backup single-flight', () => {
  it('reuses one batch export when duplicate cron requests overlap in the same instance', async () => {
    let resolveBackup: (value: any) => void = () => {};
    const pendingBackup = new Promise((resolve) => {
      resolveBackup = resolve;
    });
    const backupService = {
      createScheduledBackupBatch: jest.fn().mockReturnValue(pendingBackup),
    } as any;
    const controller = new BackupController(backupService);
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'cron-test-secret';

    const createRequest = () => {
      const req = new EventEmitter() as any;
      req.headers = { authorization: 'Bearer cron-test-secret' };
      return req;
    };

    try {
      const first = controller.autoBackup(createRequest());
      const second = controller.autoBackup(createRequest());
      expect(backupService.createScheduledBackupBatch).toHaveBeenCalledTimes(1);

      resolveBackup({
        batchId: 'batch_test_1',
        periodKey: '2026-09',
        status: 'succeeded',
      });

      await expect(first).resolves.toEqual({
        success: true,
        data: { batchId: 'batch_test_1', periodKey: '2026-09', status: 'succeeded' },
      });
      await expect(second).resolves.toEqual({
        success: true,
        data: { batchId: 'batch_test_1', periodKey: '2026-09', status: 'succeeded' },
      });
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it('未配置或提供错误 CRON_SECRET 时抛出 403 ForbiddenException', async () => {
    const backupService = {
      createScheduledBackupBatch: jest.fn(),
    } as any;
    const controller = new BackupController(backupService);
    process.env.CRON_SECRET = 'secret_123';

    await expect(
      controller.autoBackup({ headers: { authorization: 'Bearer wrong' } }),
    ).rejects.toThrow('未授权的定时备份请求');
  });
});
