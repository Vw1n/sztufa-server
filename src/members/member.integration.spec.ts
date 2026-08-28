import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MemberService } from './member.service';
import { CardStoreService } from './card-store.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { assertSafeTestEnvironment } from '../common/test-env-whitelist';
import { consumeRollingLogin, loginLimitPrefix } from '../common/rolling-login-limit';

const databaseUrl = process.env.DATABASE_URL || '';
const storageEndpoint = process.env.CARD_R2_ENDPOINT || '';
const bucketName = process.env.CARD_R2_BUCKET_NAME || '';

assertSafeTestEnvironment({
  databaseUrl,
  storageEndpoint,
  bucketName,
});

describe('MemberService PostgreSQL 事务与并发集成测试', () => {
  let prisma: PrismaClient;
  let service: MemberService;

  const trackedMemberIds = new Set<string>();
  const trackedObjectKeys = new Set<string>();

  const store = {
    normalize: jest.fn().mockImplementation(async () => Buffer.from('webp-card-test')),
    put: jest.fn().mockImplementation(async (key: string) => {
      trackedObjectKeys.add(key);
    }),
    read: jest.fn().mockResolvedValue(Buffer.from('webp-card-test')),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as CardStoreService;

  const jwt = new JwtService({ secret: 'integration-jwt-secret' });
  const config = {
    get: jest.fn().mockReturnValue('integration-jwt-secret'),
  } as unknown as ConfigService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    service = new MemberService(prisma as never, jwt, config, store);
  });

  const createTestMemberWithAsset = async (prefix: string, studentId: string) => {
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const username = `${prefix}_${uniqueSuffix}`;
    const objectKey = `campus-cards/integration_${uniqueSuffix}.webp`;
    trackedObjectKeys.add(objectKey);

    const asset = await prisma.campusCardAsset.create({
      data: {
        objectKey,
        deleteAfter: new Date(Date.now() + 86400_000),
        state: 'READY',
        version: 1,
      },
    });

    const member = await prisma.memberAccount.create({
      data: {
        username,
        password: '$scrypt$N=32768,r=8,p=1$c29tZXNhbHQ$somehash',
        nickname: `测试用户_${uniqueSuffix}`,
        realName: `测试姓名_${uniqueSuffix}`,
        requestedStudentId: studentId,
        verificationStatus: 'PENDING',
        verificationVersion: 1,
      },
    });

    await prisma.campusCardAsset.update({
      where: { id: asset.id },
      data: { memberId: member.id },
    });

    trackedMemberIds.add(member.id);
    return { member, asset, objectKey };
  };

  afterEach(async () => {
    for (const memberId of Array.from(trackedMemberIds)) {
      const assets = await prisma.campusCardAsset.findMany({
        where: { memberId },
        select: { id: true, objectKey: true },
      });
      for (const a of assets) {
        trackedObjectKeys.add(a.objectKey);
      }

      // 本套件存储为 mock；任何清理错误仍必须中止账本删除。
      for (const a of assets) await store.remove(a.objectKey);
      await prisma.campusCardAsset.deleteMany({ where: { memberId } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ username: memberId }, { details: { contains: memberId } }],
        },
      });
      await prisma.memberAccount.deleteMany({ where: { id: memberId } });
      trackedMemberIds.delete(memberId);
    }
    for (const key of trackedObjectKeys) {
      await store.remove(key);
      await prisma.campusCardAsset.deleteMany({ where: { objectKey: key } });
    }
    trackedObjectKeys.clear();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('滑动限流跨固定窗口仍拒绝第 11 次，并在真实并发下不超发', async () => {
    const path = '/api/v1/member-auth/login';
    const key = `account:rolling-test-${Date.now()}`;
    const prefix = loginLimitPrefix(path, key);
    const clock = jest.spyOn(Date, 'now');
    const boundary = Math.ceil(new Date().getTime() / 600_000) * 600_000;
    try {
      clock.mockReturnValue(boundary - 1000);
      for (let i = 0; i < 10; i++) {
        expect(await consumeRollingLogin(prisma as never, path, key, 10)).toBe(true);
      }
      clock.mockReturnValue(boundary + 1000);
      expect(await consumeRollingLogin(prisma as never, path, key, 10)).toBe(false);
      clock.mockReturnValue(boundary + 600_001);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => consumeRollingLogin(prisma as never, path, key, 10)),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
    } finally {
      clock.mockRestore();
      await prisma.authRateLimit.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('25 个未决清理任务再次到期时，仍优先处理尚未尝试的正常材料', async () => {
    const keys = Array.from({ length: 26 }, (_, i) => `campus-cards/fair-${Date.now()}-${i}.webp`);
    keys.forEach((key) => trackedObjectKeys.add(key));
    await prisma.campusCardAsset.createMany({
      data: keys.map((objectKey, i) => ({
        objectKey,
        state: 'DELETE_PENDING',
        uploadSettled: i === 25,
        deleteAfter: new Date(1000 + i),
        nextAttemptAt: new Date(1000 + i),
      })),
    });
    expect((await service.cleanup()).deleted).toBe(0);
    // Make retries due again without waiting, as with a scheduler slower than retry delay.
    await prisma.campusCardAsset.updateMany({
      where: { objectKey: { in: keys.slice(0, 25) } },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect((await service.cleanup()).deleted).toBe(1);
    expect(
      (await prisma.campusCardAsset.findUniqueOrThrow({ where: { objectKey: keys[25] } })).state,
    ).toBe('DELETED');
    expect(
      await prisma.campusCardAsset.count({
        where: { objectKey: { in: keys.slice(0, 25) }, state: 'DELETED' },
      }),
    ).toBe(0);
  });

  it('同一申请版本并发审核：两并发请求仅恰好 1 个获胜，另 1 个被拒绝，数据库保持一致', async () => {
    const { member } = await createTestMemberWithAsset('concurrent_review', '20269901');

    const results = await Promise.allSettled([
      service.review(member.id, { decision: 'APPROVED', version: 1 }, 'admin_1'),
      service.review(member.id, { decision: 'APPROVED', version: 1 }, 'admin_2'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = rejected[0].reason;
    const isConflict =
      err instanceof ConflictException ||
      err?.code === 'P2034' ||
      err?.message?.includes('冲突') ||
      err?.message?.includes('修改');
    expect(isConflict).toBe(true);

    const updated = await prisma.memberAccount.findUniqueOrThrow({ where: { id: member.id } });
    expect(updated.verificationStatus).toBe('APPROVED');
    expect(updated.studentId).toBe('20269901');

    const asset = await prisma.campusCardAsset.findFirst({ where: { memberId: member.id } });
    expect(asset?.state).toBe('DELETED');
    expect(asset?.deletedAt).not.toBeNull();
  });

  it('学号唯一性冲突时回滚审核：不覆盖已有学号，审核状态维持不变', async () => {
    const { member: memberA } = await createTestMemberWithAsset('dup_student_a', '20268888');
    await service.review(memberA.id, { decision: 'APPROVED', version: 1 }, 'admin_1');

    const { member: memberB } = await createTestMemberWithAsset('dup_student_b', '20268888');

    let errorCaught: any = null;
    try {
      await service.review(memberB.id, { decision: 'APPROVED', version: 1 }, 'admin_2');
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();

    const unchangedB = await prisma.memberAccount.findUniqueOrThrow({ where: { id: memberB.id } });
    expect(unchangedB.verificationStatus).toBe('PENDING');
    expect(unchangedB.studentId).toBeNull();
  });

  it('499 份材料时两事务同步读取最后名额，仅一个成功，另一个重试后 503', async () => {
    const dummyKeys: string[] = [];
    const currentUnreleased = await prisma.campusCardAsset.count({
      where: { state: { not: 'DELETED' } },
    });
    const needed = 499 - currentUnreleased;
    expect(needed).toBeGreaterThanOrEqual(0);
    const dummyAssetData = Array.from({ length: Math.max(0, needed) }).map((_, i) => ({
      objectKey: `campus-cards/cap_pre499_${Date.now()}_${i}.webp`,
      state: 'READY',
      deleteAfter: new Date(Date.now() + 86400_000),
    }));

    for (const d of dummyAssetData) {
      dummyKeys.push(d.objectKey);
    }

    // 预先补齐至 499 份材料
    if (dummyAssetData.length > 0) {
      await prisma.campusCardAsset.createMany({ data: dummyAssetData });
    }

    try {
      // 在真实事务完成 count 后设置屏障，确保不是偶然串行执行。
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, options: any) =>
        transaction(
          async (tx: any) =>
            fn(
              new Proxy(tx, {
                get(target, prop) {
                  if (prop !== 'campusCardAsset') return target[prop];
                  return new Proxy(target.campusCardAsset, {
                    get(delegate, method) {
                      if (method === 'count')
                        return async (args: any) => {
                          const count = await delegate.count(args);
                          if (++arrived <= 2) {
                            if (arrived === 2) release();
                            await barrier;
                          }
                          return count;
                        };
                      if (method === 'create')
                        return async (args: any) => {
                          trackedObjectKeys.add(args.data.objectKey);
                          return delegate.create(args);
                        };
                      return delegate[method];
                    },
                  });
                },
              }),
            ),
          { ...options, timeout: 15000 },
        )) as any);
      let results: PromiseSettledResult<any>[];
      try {
        results = await Promise.allSettled(
          Array.from({ length: 2 }, () =>
            (service as any).stage({ buffer: Buffer.from('fake-png') }),
          ),
        );
      } finally {
        release();
        spy.mockRestore();
      }

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      for (const rej of rejected) {
        if (rej.status === 'rejected') {
          expect(rej.reason).toBeInstanceOf(ServiceUnavailableException);
        }
      }

      // 校验数据库中实际未释放材料总数严格等于 500 份（499 + 1）
      const totalUnreleased = await prisma.campusCardAsset.count({
        where: { state: { not: 'DELETED' } },
      });
      expect(totalUnreleased).toBe(500);
    } finally {
      await prisma.campusCardAsset.deleteMany({
        where: { objectKey: { in: dummyKeys } },
      });
    }
  });

  it('真实 stage/cleanup 竞争：在途 PUT 的 404 不释放容量，确认写入完成后才可删除', async () => {
    let finish!: () => void;
    let started!: (key: string) => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const writing = new Promise<string>((resolve) => {
      started = resolve;
    });
    let exists = false;
    (store.put as jest.Mock).mockImplementationOnce(async (key: string) => {
      trackedObjectKeys.add(key);
      started(key);
      await pending;
      exists = true;
    });
    const remove = jest.spyOn(store, 'remove').mockImplementation(async () => {
      exists = false;
    });
    const upload = (service as any).stage({ buffer: Buffer.from('fake-png') });
    try {
      const key = await writing;
      const asset = await prisma.campusCardAsset.findUniqueOrThrow({ where: { objectKey: key } });
      await prisma.campusCardAsset.update({
        where: { id: asset.id },
        data: {
          leaseUntil: new Date(Date.now() - 1000),
        },
      });
      await service.cleanup();
      const uncertain = await prisma.campusCardAsset.findUniqueOrThrow({ where: { id: asset.id } });
      expect(uncertain.state).toBe('DELETE_PENDING');
      expect(uncertain.uploadSettled).toBe(false);
      expect(uncertain.deletedAt).toBeNull();
      finish();
      await expect(upload).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(exists).toBe(true);
      await prisma.campusCardAsset.update({
        where: { id: asset.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await service.cleanup();
      expect(exists).toBe(false);
      expect(
        (await prisma.campusCardAsset.findUniqueOrThrow({ where: { id: asset.id } })).state,
      ).toBe('DELETED');
    } finally {
      finish();
      await upload.catch(() => undefined);
      remove.mockRestore();
    }
  });
});
