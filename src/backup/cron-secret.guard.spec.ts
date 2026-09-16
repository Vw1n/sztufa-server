import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CronSecretGuard } from './cron-secret.guard';

describe('CronSecretGuard', () => {
  let guard: CronSecretGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    guard = new CronSecretGuard();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createMockContext(headers: Record<string, string>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    } as any;
  }

  it('正确 Bearer token', () => {
    expect(guard.canActivate(createMockContext({ authorization: 'Bearer test-secret' }))).toBe(
      true,
    );
  });

  it('CRON_SECRET 未设置时抛出 ForbiddenException', () => {
    delete process.env.CRON_SECRET;
    expect(() =>
      guard.canActivate(createMockContext({ authorization: 'Bearer test-secret' })),
    ).toThrow(ForbiddenException);
  });

  it('错误 token 抛出 ForbiddenException', () => {
    expect(() =>
      guard.canActivate(createMockContext({ authorization: 'Bearer wrong-secret' })),
    ).toThrow(ForbiddenException);
  });

  it('空 Authorization header 抛出 ForbiddenException', () => {
    expect(() => guard.canActivate(createMockContext({}))).toThrow(ForbiddenException);
  });

  it('非 Bearer 前缀 抛出 ForbiddenException', () => {
    expect(() =>
      guard.canActivate(createMockContext({ authorization: 'Basic test-secret' })),
    ).toThrow(ForbiddenException);
  });

  it('token 长度与 expected 不同', () => {
    expect(() => guard.canActivate(createMockContext({ authorization: 'Bearer short' }))).toThrow(
      ForbiddenException,
    );
  });
});
