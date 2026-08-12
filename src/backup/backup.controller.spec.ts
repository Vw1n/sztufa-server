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
  const coachToken = 'Bearer valid_coach_token';

  beforeEach(async () => {
    mockBackupService = {
      createBackup: jest
        .fn()
        .mockResolvedValue({ key: 'private-backups/database/backup_123.json.gz' }),
      createScheduledBackup: jest
        .fn()
        .mockResolvedValue({ key: 'private-backups/database/backup_scheduled.json.gz' }),
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
          if (auth === coachToken) {
            req.user = { id: 'u_coach', username: 'coach_john', role: 'coach' };
            return true;
          }
          return false;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
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
    await request(app.getHttpServer()).post('/api/v1/backups/upload/init').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/upload/complete').expect(403);
    await request(app.getHttpServer()).delete('/api/v1/backups').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/retention/clean').expect(403);
    await request(app.getHttpServer()).post('/api/v1/backups/restore').expect(403);
  });

  it('普通教练身份 (coach) 访问备份受控 API 应当返回 403 Forbidden 拦截', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backups/create')
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

  it('超级管理员 (super_admin) 访问受控 API 应当成功通过 (200 / 201 OK)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backups/create')
      .set('Authorization', superAdminToken)
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/backups/list')
      .set('Authorization', superAdminToken)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/backups/upload/init')
      .set('Authorization', superAdminToken)
      .send({ filename: 'b.json.gz', size: 100, sha256: 'a'.repeat(64) })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/backups/upload/complete')
      .set('Authorization', superAdminToken)
      .send({ uploadToken: 'token.sig' })
      .expect(201);

    await request(app.getHttpServer())
      .delete('/api/v1/backups')
      .set('Authorization', superAdminToken)
      .send({ key: 'private-backups/database/b.json.gz', confirmText: 'DELETE_BACKUP' })
      .expect(200);
  });
});

describe('BackupController scheduled backup single-flight', () => {
  it('reuses one export when duplicate cron requests overlap in the same instance', async () => {
    let resolveBackup: (value: any) => void = () => {};
    const pendingBackup = new Promise((resolve) => {
      resolveBackup = resolve;
    });
    const backupService = {
      createScheduledBackup: jest.fn().mockReturnValue(pendingBackup),
    } as any;
    const controller = new BackupController(backupService);
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'cron-test-secret';

    const createRequest = () => {
      const req = new EventEmitter() as any;
      req.headers = { authorization: 'Bearer cron-test-secret' };
      req.off = req.removeListener.bind(req);
      return req;
    };
    const createResponse = () => {
      const res = new EventEmitter() as any;
      res.writableEnded = false;
      res.off = res.removeListener.bind(res);
      return res;
    };

    try {
      const first = controller.autoBackup(createRequest(), createResponse());
      const second = controller.autoBackup(createRequest(), createResponse());
      expect(backupService.createScheduledBackup).toHaveBeenCalledTimes(1);

      resolveBackup({ key: 'private-backups/database/full/scheduled.json.gz' });

      await expect(first).resolves.toEqual({
        success: true,
        data: { key: 'private-backups/database/full/scheduled.json.gz' },
      });
      await expect(second).resolves.toEqual({
        success: true,
        data: { key: 'private-backups/database/full/scheduled.json.gz' },
      });
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });
});
