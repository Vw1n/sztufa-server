import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { MemberAdminController, MemberAuthController } from './member.controller';
import { MemberService } from './member.service';
import { MemberJwtStrategy } from './member-auth.guard';
import { AuthRateGuard } from './auth-rate.guard';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { AuthService } from '../auth/auth.service';
import { PrismaClientExceptionFilter } from '../prisma/prisma-client-exception.filter';
// This suite uses an in-memory Prisma substitute; real rolling limits are integration-tested.
jest.mock('../common/rolling-login-limit', () => ({
  ...jest.requireActual('../common/rolling-login-limit'),
  consumeRollingLogin: jest.fn().mockResolvedValue(true),
}));

describe('账号隔离 HTTP 边界与会话生命周期', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'only-for-http-tests' });

  const statefulMember = {
    id: 'm1',
    username: 'student',
    disabled: false,
    sessionVersion: 0,
    role: 'user',
    accountType: 'member',
    verificationStatus: 'PENDING',
    verificationVersion: 1,
  };

  const members = {
    validate: jest.fn().mockImplementation(async (payload: any) => {
      if (
        payload.accountType !== 'member' ||
        payload.aud !== 'member' ||
        payload.userId !== statefulMember.id
      )
        return null;
      if (statefulMember.disabled || statefulMember.sessionVersion !== payload.sessionVersion)
        return null;
      return {
        id: statefulMember.id,
        username: statefulMember.username,
        role: 'user',
        accountType: 'member',
      };
    }),
    me: jest.fn(),
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    register: jest.fn().mockResolvedValue({ success: true }),
    preview: jest.fn(),
    review: jest.fn().mockResolvedValue({ success: true }),
    setDisabled: jest.fn().mockImplementation(async (id: string, disabled: boolean) => {
      if (id === statefulMember.id) {
        statefulMember.disabled = disabled;
        statefulMember.sessionVersion += 1;
      }
      return { success: true };
    }),
    resetPassword: jest.fn().mockImplementation(async (id: string) => {
      if (id === statefulMember.id) {
        statefulMember.sessionVersion += 1;
      }
      return { success: true };
    }),
    logout: jest.fn().mockImplementation(async (id: string) => {
      if (id === statefulMember.id) {
        statefulMember.sessionVersion += 1;
      }
      return { success: true };
    }),
    login: jest.fn().mockImplementation(async (username: string) => {
      if (username === statefulMember.username && !statefulMember.disabled) {
        return {
          user: {
            id: statefulMember.id,
            username: statefulMember.username,
            role: 'user',
            accountType: 'member',
          },
          token: jwt.sign(
            {
              userId: statefulMember.id,
              accountType: 'member',
              sessionVersion: statefulMember.sessionVersion,
            },
            { audience: 'member', expiresIn: '5m' },
          ),
        };
      }
      throw new UnauthorizedException();
    }),
  };

  const memberToken = (version = statefulMember.sessionVersion) =>
    jwt.sign(
      { userId: statefulMember.id, accountType: 'member', sessionVersion: version },
      { audience: 'member', expiresIn: '5m' },
    );

  const staffToken = (aud: string, role = 'super_admin') =>
    jwt.sign({ userId: 'staff_1', accountType: aud, role }, { audience: aud, expiresIn: '5m' });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [MemberAdminController, MemberAuthController],
      providers: [
        MemberJwtStrategy,
        JwtStrategy,
        AuthRateGuard,
        { provide: ConfigService, useValue: { get: () => 'only-for-http-tests' } },
        { provide: MemberService, useValue: members },
        {
          provide: AuthService,
          useValue: {
            validateUser: (payload: any) => ({ id: payload.userId, role: payload.role }),
          },
        },
        {
          provide: PrismaService,
          useValue: { authRateLimit: { upsert: jest.fn().mockResolvedValue({ count: 1 }) } },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new PrismaClientExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('匿名和普通用户无法访问后台用户列表', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/members').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/members')
      .auth(memberToken(), { type: 'bearer' })
      .expect(401);
  });

  it('非超管工作人员不能查看材料，超管可读取独立列表', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/members/m1/cards/a1')
      .auth(staffToken('staff', 'coach'), { type: 'bearer' })
      .expect(403);
    expect(members.preview).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/api/v1/admin/members')
      .auth(staffToken('staff'), { type: 'bearer' })
      .expect(200);
  });

  it('工作人员令牌不能用于普通用户端', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(staffToken('staff'), { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(memberToken(), { type: 'bearer' })
      .expect(200);
  });

  it('注册拒绝角色注入及空白用户名', async () => {
    const body = {
      username: 'student',
      password: 'A-long-campus-secret!2026',
      realName: '学生',
      studentId: '20260001',
      consentVersion: 'campus-card-v1',
    };
    await request(app.getHttpServer())
      .post('/api/v1/member-auth/register')
      .send({ ...body, role: 'super_admin' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/member-auth/register')
      .send({ ...body, username: '   ' })
      .expect(400);
    expect(members.register).not.toHaveBeenCalled();
  });

  it('注册拒绝超大上传，审核拒绝不合法状态', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/member-auth/register')
      .attach('campusCard', Buffer.alloc(3 * 1024 * 1024 + 1), 'card.jpg')
      .expect(413);
    await request(app.getHttpServer())
      .patch('/api/v1/admin/members/m1/review')
      .auth(staffToken('staff'), { type: 'bearer' })
      .send({ decision: 'ADMIN', version: 1 })
      .expect(400);
  });

  it('严格验证会话版本递增与全流程会话撤销 (T1 -> 退出 -> T2 -> 停用/启用 -> T3 -> 重置密码 -> T4)', async () => {
    statefulMember.sessionVersion = 0;
    statefulMember.disabled = false;

    // 1. 初始有效令牌 T1 (版本 0)
    const t1 = memberToken(0);
    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t1, { type: 'bearer' })
      .expect(200);

    // 2. 调用退出接口，版本递增为 1，T1 立即失效返回 401
    await request(app.getHttpServer())
      .post('/api/v1/member-auth/logout')
      .auth(t1, { type: 'bearer' })
      .expect(201);
    expect(statefulMember.sessionVersion).toBe(1);

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t1, { type: 'bearer' })
      .expect(401);

    // 3. 登录获取新令牌 T2 (版本 1) 并验证有效
    const loginRes2 = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username: 'student', password: 'ValidPassword!2026' })
      .expect(201);
    const t2 = loginRes2.body.token;

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t2, { type: 'bearer' })
      .expect(200);

    // 4. 超管停用账号，版本递增为 2，T2 立即失效返回 401
    await request(app.getHttpServer())
      .patch('/api/v1/admin/members/m1/status')
      .auth(staffToken('staff'), { type: 'bearer' })
      .send({ disabled: true })
      .expect(200);
    expect(statefulMember.sessionVersion).toBe(2);

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t2, { type: 'bearer' })
      .expect(401);

    // 5. 超管重新启用账号，版本再次递增为 3，旧令牌 T2 依然失效
    await request(app.getHttpServer())
      .patch('/api/v1/admin/members/m1/status')
      .auth(staffToken('staff'), { type: 'bearer' })
      .send({ disabled: false })
      .expect(200);
    expect(statefulMember.sessionVersion).toBe(3);

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t2, { type: 'bearer' })
      .expect(401);

    // 6. 重新登录取得有效令牌 T3 (版本 3)，先确认 T3 可正常访问
    const loginRes3 = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username: 'student', password: 'ValidPassword!2026' })
      .expect(201);
    const t3 = loginRes3.body.token;

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t3, { type: 'bearer' })
      .expect(200);

    // 7. 超管重置密码，版本递增为 4，T3 立即失效返回 401
    await request(app.getHttpServer())
      .patch('/api/v1/admin/members/m1/reset-password')
      .auth(staffToken('staff'), { type: 'bearer' })
      .send({ password: 'ResetPassword!2026' })
      .expect(200);
    expect(statefulMember.sessionVersion).toBe(4);

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t3, { type: 'bearer' })
      .expect(401);

    // 8. 重新登录获取新令牌 T4 (版本 4)，验证新会话有效
    const loginRes4 = await request(app.getHttpServer())
      .post('/api/v1/member-auth/login')
      .send({ username: 'student', password: 'ResetPassword!2026' })
      .expect(201);
    const t4 = loginRes4.body.token;

    await request(app.getHttpServer())
      .get('/api/v1/member-auth/me')
      .auth(t4, { type: 'bearer' })
      .expect(200);
  });
});
