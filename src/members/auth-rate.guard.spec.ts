import { AuthRateGuard } from './auth-rate.guard';
import { createHash } from 'crypto';
import { MemberService } from './member.service';

// These tests isolate the legacy fixed-window counter. Rolling limits use real DB tests.
jest.mock('../common/rolling-login-limit', () => ({
  ...jest.requireActual('../common/rolling-login-limit'),
  consumeRollingLogin: jest.fn().mockResolvedValue(true),
}));

describe('认证限流算法（内存持久层替身）与真实密码重置服务调用', () => {
  it('多个守卫实例共享账号配额，跨 IP 登录仍受账号限制，第 11 次请求触发 429', async () => {
    const counts = new Map<string, number>();
    const prisma = {
      authRateLimit: {
        upsert: jest.fn(async ({ where }: any) => {
          const count = (counts.get(where.id) || 0) + 1;
          counts.set(where.id, count);
          return { count };
        }),
      },
    };
    const a = new AuthRateGuard(prisma as never);
    const b = new AuthRateGuard(prisma as never);

    const context = (ip: string, path = '/api/v1/member-auth/login') => ({
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          path,
          body: { username: 'student' },
        }),
      }),
    });

    // 前 10 次请求正常通过
    for (let i = 0; i < 10; i++) {
      const path = i % 2 ? '/api/v1/auth/LOGIN/' : '/api/v1/staff-auth/login';
      await expect(a.canActivate(context(`test-${i}`, path) as never)).resolves.toBe(true);
    }

    // 第 11 次请求（即使来自不同 IP）必须因账号上限被 429 拒绝
    await expect(
      b.canActivate(context('another-ip', '/api/v1/staff-auth/login') as never),
    ).rejects.toMatchObject({
      status: 429,
    });

    // 普通用户与工作人员账号空间仍独立计数。
    await expect(b.canActivate(context('another-ip') as never)).resolves.toBe(true);
    expect([...counts.keys()].every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  });

  it('单 IP 登录请求超过 100 次阈值时必须触发 429 限流', async () => {
    const counts = new Map<string, number>();
    const prisma = {
      authRateLimit: {
        upsert: jest.fn(async ({ where }: any) => {
          const count = (counts.get(where.id) || 0) + 1;
          counts.set(where.id, count);
          return { count };
        }),
      },
    };
    const guard = new AuthRateGuard(prisma as never);
    const context = (username: string) => ({
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '192.168.1.100',
          path: '/api/v1/member-auth/login',
          body: { username },
        }),
      }),
    });

    // 发起 100 次不同用户名的请求（避免触发单账号 10 次限制）
    for (let i = 0; i < 100; i++) {
      await expect(guard.canActivate(context(`user_${i}`) as never)).resolves.toBe(true);
    }

    // 第 101 次请求应因 IP 达到 100 次上限而被 429 拒绝
    await expect(guard.canActivate(context('user_101') as never)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('重置密码仅清除目标账号的限流记录，保留来源攻击 IP 的限流桶', async () => {
    const limits = new Map<string, { id: string; count: number; key: string }>();
    const prisma = {
      authRateLimit: {
        upsert: jest.fn(async ({ where }: any) => {
          const existing = limits.get(where.id);
          const count = (existing?.count || 0) + 1;
          const rec = { id: where.id, count, key: where.id };
          limits.set(where.id, rec);
          return rec;
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          // MemberService.resetPassword 计算 account key hash 并只删除 account 记录
          let deletedCount = 0;
          for (const [id] of Array.from(limits.entries())) {
            if (where?.id === id || where?.id?.in?.includes(id)) {
              limits.delete(id);
              deletedCount++;
            }
          }
          return { count: deletedCount };
        }),
      },
    };

    const guard = new AuthRateGuard(prisma as never);
    const attackerIp = '203.0.113.55';
    const targetUsername = 'victim_user';

    const loginCtx = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: attackerIp,
          path: '/api/v1/member-auth/login',
          body: { username: targetUsername },
        }),
      }),
    };

    // 攻击者连续尝试 10 次触发账号限流
    for (let i = 0; i < 10; i++) {
      await guard.canActivate(loginCtx as never);
    }
    await expect(guard.canActivate(loginCtx as never)).rejects.toMatchObject({ status: 429 });

    // 管理员重置 victim_user 密码：计算对应账号的 hash 并只删除 account 桶
    const windowMs = 10 * 60 * 1000;
    const slot = Math.floor(Date.now() / windowMs);
    const path = '/api/v1/member-auth/login';
    const accountHash = createHash('sha256')
      .update(`${path}:${slot}:account:${targetUsername}`)
      .digest('hex');

    const servicePrisma = Object.assign(prisma, {
      memberAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'victim', username: targetUsername }),
        update: jest.fn().mockResolvedValue({ id: 'victim' }),
      },
      auditLog: { create: jest.fn() },
      $transaction: async (fn: any) => fn(servicePrisma),
    });
    const service = new MemberService(servicePrisma as never, {} as never, {} as never, {} as never);
    await service.resetPassword('victim', 'ReplacementPass!2026', 'admin', '192.0.2.1');
    expect(limits.has(accountHash)).toBe(false);

    // 账号桶已清空，合法用户（换新 IP）可以正常登录
    const legitCtx = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '198.51.100.12',
          path: '/api/v1/member-auth/login',
          body: { username: targetUsername },
        }),
      }),
    };
    await expect(guard.canActivate(legitCtx as never)).resolves.toBe(true);

    // 来源攻击 IP 桶依然存在且持续累加计次
    const ipHash = createHash('sha256')
      .update(`${path}:${slot}:ip:${attackerIp}`)
      .digest('hex');
    expect(limits.has(ipHash)).toBe(true);
    expect(limits.get(ipHash)?.count).toBeGreaterThanOrEqual(10);
  });

  it('守卫只使用 req.ip，不直接读取转发头（Express 解析由独立 HTTP 测试覆盖）', async () => {
    const counts = new Map<string, number>();
    const prisma = {
      authRateLimit: {
        upsert: jest.fn(async ({ where }: any) => {
          const count = (counts.get(where.id) || 0) + 1;
          counts.set(where.id, count);
          return { count };
        }),
      },
    };
    const guard = new AuthRateGuard(prisma as never);

    // 攻击者每次请求附带随机伪造的 X-Forwarded-For 头，但 Express 将其固定为真实未受信任 IP 198.51.100.99
    const spoofedContext = (spoofedIp: string, username: string) => ({
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '198.51.100.99', // Express 根据严格的 trust proxy 解析后的真实客户端 IP
          headers: { 'x-forwarded-for': spoofedIp },
          path: '/api/v1/member-auth/login',
          body: { username },
        }),
      }),
    });

    for (let i = 0; i < 100; i++) {
      await expect(
        guard.canActivate(spoofedContext(`10.0.0.${i}`, `fake_user_${i}`) as never),
      ).resolves.toBe(true);
    }

    // 即使伪造了新的 X-Forwarded-For，第 101 次请求依然被真实 IP 100 次限额拦截
    await expect(
      guard.canActivate(spoofedContext('1.1.1.1', 'fake_user_101') as never),
    ).rejects.toMatchObject({ status: 429 });
  });
});
