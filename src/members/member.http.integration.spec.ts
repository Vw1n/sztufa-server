import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { CardStoreService } from './card-store.service';
import { createHash } from 'crypto';
import { loginLimitPrefix } from '../common/rolling-login-limit';
import { trustedProxyConfig } from '../common/trusted-proxy';
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

import { assertSafeTestEnvironment } from '../common/test-env-whitelist';

const databaseUrl = process.env.DATABASE_URL || '';
const storageEndpoint =
  process.env.CARD_R2_ENDPOINT || '';
const bucketName =
  process.env.CARD_R2_BUCKET_NAME || '';

assertSafeTestEnvironment({
  databaseUrl,
  storageEndpoint,
  bucketName,
});

if (!process.env.CARD_R2_ACCESS_KEY_ID || !process.env.CARD_R2_SECRET_ACCESS_KEY) {
  throw new Error('测试存储凭据必须显式配置');
}

describe('Member HTTP Integration (真实会话生命周期与权限契约链)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let s3: S3Client;
  let putSpy: jest.SpyInstance;

  const uniqueId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const username = `http_user_${uniqueId}`;
  const rawPassword = 'InitialPass!2026';
  const newPassword = 'UpdatedPass!2026';
  const studentId = `2026${Math.floor(100000 + Math.random() * 900000)}`;

  let memberId = '';
  let token1 = '';
  let token2 = '';
  let token3 = '';
  let token4 = '';
  let adminToken = '';

  const trackedObjectKeys = new Set<string>();

  const syntheticCardPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOIbtmIFTEMLQkA/YJkAS1igrkAAAAASUVORK5CYII=',
    'base64',
  );

  beforeAll(async () => {
    s3 = new S3Client({
      endpoint: storageEndpoint,
      region: 'auto',
      credentials: {
        accessKeyId: process.env.CARD_R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.CARD_R2_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // 仅信任测试进程的回环连接，真实经过 Express 解析转发头。
    app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyConfig({
      TRUST_PROXY: '127.0.0.1/32,::1/128',
    }));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    const store = app.get(CardStoreService);
    const put = store.put.bind(store);
    // 在调用真实存储前记录键，注册事务失败时也能找到未绑定材料。
    putSpy = jest.spyOn(store, 'put').mockImplementation(async (key, body) => {
      trackedObjectKeys.add(key);
      return put(key, body);
    });

    // 获取/准备管理端超管 Token
    const adminLoginRes = await request(app.getHttpServer())
      .post('/api/v1/staff-auth/login')
      .send({ username: 'admin', password: 'admin123' });

    if (adminLoginRes.status === 201) {
      adminToken = adminLoginRes.body.token;
    } else {
      const altLogin = await request(app.getHttpServer())
        .post('/api/v1/staff-auth/login')
        .send({ username: 'admin', password: 'admin123456' });
      adminToken = altLogin.body.token;
    }
  });

  afterAll(async () => {
    try {
      const cleanupErrors: Error[] = [];

      if (!memberId && prisma) {
        memberId = (await prisma.memberAccount.findUnique({ where: { username } }))?.id || '';
      }

      // 1. 获取所有生成材料的 S3 objectKey
      if (memberId) {
        const assets = await prisma.campusCardAsset.findMany({
          where: { memberId },
        });
        for (const a of assets) {
          trackedObjectKeys.add(a.objectKey);
        }
      }

      // 2. S3 物理删除并执行只读 HEAD 404 确认
      for (const key of Array.from(trackedObjectKeys)) {
        try {
          const asset = await prisma.campusCardAsset.findUnique({ where: { objectKey: key } });
          if (asset?.uploadSettled === false) {
            cleanupErrors.push(new Error('测试材料写入结果未确认，保留账本和配额供排查'));
            continue;
          }
          await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
          let is404 = false;
          try {
            await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
          } catch (headErr: any) {
            if (
              headErr?.name === 'NotFound' ||
              headErr?.$metadata?.httpStatusCode === 404 ||
              headErr?.Code === 'NoSuchKey'
            ) {
              is404 = true;
            }
          }
          if (!is404) {
            cleanupErrors.push(new Error(`S3 对象未能确认物理删除 (404): ${key}`));
          }
        } catch (err: any) {
          cleanupErrors.push(err);
        }
      }

      // 若 S3 物理删除存在任何未确认项，严禁删除 DB 账本并立即报错
      if (cleanupErrors.length > 0) {
        throw new Error(
          `集成测试 S3 资源物理清理失败，已保留数据库账本: ${cleanupErrors.map((e) => e.message).join('; ')}`,
        );
      }

      // 3. 只有在 S3 物理删除 100% 确认后，方可删除数据库记录
      await prisma.campusCardAsset.deleteMany({ where: { objectKey: { in: [...trackedObjectKeys] } } });
      if (memberId) {
        await prisma.campusCardAsset.deleteMany({ where: { memberId } });
        await prisma.auditLog.deleteMany({
          where: {
            OR: [
              { username: memberId },
              { details: { contains: memberId } },
            ],
          },
        });
        await prisma.memberAccount.deleteMany({ where: { id: memberId } });
      }
    } finally {
      putSpy?.mockRestore();
      await app?.close();
    }
  });

  it('1. POST /member-auth/register -> 201 Created (获得 T1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/register')
      .field('username', username)
      .field('password', rawPassword)
      .field('realName', `测试用户_${uniqueId}`)
      .field('studentId', studentId)
      .field('consentVersion', 'campus-card-v1')
      .attach('campusCard', syntheticCardPng, 'card.png');

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe(username);
    expect(res.body.user.password).toBeUndefined();

    memberId = res.body.user.id;
    token1 = res.body.token;

    const assets = await prisma.campusCardAsset.findMany({ where: { memberId } });
    for (const a of assets) {
      trackedObjectKeys.add(a.objectKey);
    }
  });

  it('2. GET /member-auth/me (with T1) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('3. POST /member-auth/logout (with T1) -> 201 Created', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/logout')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('4. GET /member-auth/me (with T1) -> 401 Unauthorized', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(401);
  });

  it('5. POST /member-auth/login -> 201 Created (获得 T2)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username, password: rawPassword });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    token2 = res.body.token;
  });

  it('6. GET /member-auth/me (with T2) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('7. Admin PATCH /admin/members/:id/status (disabled: true) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${memberId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disabled: true });

    expect(res.status).toBe(200);
  });

  it('8. GET /member-auth/me (with T2) -> 401 Unauthorized (已停用)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(401);
  });

  it('9. POST /member-auth/login -> 401 Unauthorized (已停用账号禁止登录)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username, password: rawPassword });

    expect(res.status).toBe(401);
  });

  it('10. Admin PATCH /admin/members/:id/status (disabled: false) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${memberId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disabled: false });

    expect(res.status).toBe(200);
  });

  it('11. GET /member-auth/me (with T2) -> 仍然 401 Unauthorized (旧 Token 不复活)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(401);
  });

  it('12. POST /member-auth/login -> 201 Created (重新登录获得 T3)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username, password: rawPassword });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    token3 = res.body.token;
  });

  it('13. GET /member-auth/me (with T3) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token3}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('14. Admin PATCH /admin/members/:id/reset-password -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${memberId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: newPassword });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('15. GET /member-auth/me (with T3) -> 401 Unauthorized (重置密码后会话撤销)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token3}`);

    expect(res.status).toBe(401);
  });

  it('16. POST /member-auth/login (使用旧密码) -> 401 Unauthorized', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username, password: rawPassword });

    expect(res.status).toBe(401);
  });

  it('17. POST /member-auth/login (使用新密码) -> 201 Created (获得 T4)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username, password: newPassword });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    token4 = res.body.token;
  });

  it('18. GET /member-auth/me (with T4) -> 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .set('Authorization', `Bearer ${token4}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('19. 真实 HTTP/数据库：第 11 次限流，重置只清账号桶而保留攻击 IP 桶', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    const slot = Math.floor(Date.now() / 600_000);
    const attackerIp = '192.0.2.81';
    const idFor = (key: string) => createHash('sha256')
      .update(`/api/v1/member-auth/login:${slot}:${key}`).digest('hex');
    const accountId = idFor(`account:${username}`);
    const ipId = idFor(`ip:${attackerIp}`);
    const prefixFor = (key: string) => loginLimitPrefix('/api/v1/member-auth/login', key);
    const rollingWhere = { OR: [`account:${username}`, `ip:${attackerIp}`, 'ip:192.0.2.82']
      .map(key => ({ id: { startsWith: prefixFor(key) } })) };
    try {
      await prisma.authRateLimit.deleteMany({ where: { id: { in: [accountId, ipId] } } });
      await prisma.authRateLimit.deleteMany({ where: rollingWhere });
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer()).post('/api/v1/member-auth/login')
          .set('X-Forwarded-For', attackerIp).send({ username, password: 'wrong-password' }).expect(401);
      }
      await request(app.getHttpServer()).post('/api/v1/member-auth/login')
        .set('X-Forwarded-For', attackerIp).send({ username, password: newPassword }).expect(429);
      await prisma.authRateLimit.update({ where: { id: ipId }, data: { count: 100 } });
      await request(app.getHttpServer()).patch(`/api/v1/admin/members/${memberId}/reset-password`)
        .set('Authorization', `Bearer ${adminToken}`).send({ password: newPassword }).expect(200);
      expect(await prisma.authRateLimit.findUnique({ where: { id: accountId } })).toBeNull();
      expect(await prisma.authRateLimit.count({ where: { id: { startsWith: `${prefixFor(`account:${username}`)}event:` } } })).toBe(0);
      expect(await prisma.authRateLimit.count({ where: { id: { startsWith: prefixFor(`ip:${attackerIp}`) } } })).toBeGreaterThan(0);
      expect((await prisma.authRateLimit.findUniqueOrThrow({ where: { id: ipId } })).count).toBe(100);
      await request(app.getHttpServer()).post('/api/v1/member-auth/login')
        .set('X-Forwarded-For', attackerIp).send({ username, password: newPassword }).expect(429);
      await request(app.getHttpServer()).post('/api/v1/member-auth/login')
        .set('X-Forwarded-For', '192.0.2.82').send({ username, password: newPassword }).expect(201);
    } finally {
      clock.mockRestore();
      await prisma.authRateLimit.deleteMany({ where: rollingWhere });
      await prisma.authRateLimit.deleteMany({ where: { id: { in: [accountId, ipId, idFor('ip:192.0.2.82')] } } });
    }
  });
});
