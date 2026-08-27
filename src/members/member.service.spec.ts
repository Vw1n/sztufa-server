import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MemberService } from './member.service';

describe('校园卡审核和持久化清理', () => {
  let prisma: any, store: any, service: MemberService;
  const member = {
    id: 'm1',
    username: 'student',
    verificationStatus: 'PENDING',
    verificationVersion: 2,
    requestedStudentId: '20260001',
    disabled: false,
    sessionVersion: 0,
  };
  const asset = {
    id: 'a1',
    objectKey: 'campus-cards/a1.webp',
    memberId: 'm1',
    version: 2,
    state: 'DELETE_PENDING',
    attempts: 0,
  };
  beforeEach(() => {
    prisma = {
      memberAccount: {
        findUnique: jest.fn().mockResolvedValue({ ...member }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
        findUniqueOrThrow: jest.fn().mockResolvedValue(member),
        create: jest.fn(),
      },
      campusCardAsset: {
        findFirst: jest.fn().mockResolvedValue({ ...asset, state: 'READY' }),
        findMany: jest.fn().mockResolvedValue([{ ...asset }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: 'a1',
          objectKey: 'campus-cards/a1.webp',
          createdAt: new Date(),
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      auditLog: { create: jest.fn() },
      authRateLimit: { deleteMany: jest.fn(), upsert: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    store = {
      remove: jest.fn().mockResolvedValue(undefined),
      read: jest.fn().mockResolvedValue(Buffer.from('card')),
      normalize: jest.fn().mockResolvedValue(Buffer.from('normalized-card')),
      put: jest.fn().mockResolvedValue(undefined),
    };
    service = new MemberService(
      prisma,
      { sign: jest.fn().mockReturnValue('mock-jwt-token') } as never,
      { get: jest.fn().mockReturnValue('jwt-secret') } as never,
      store,
    );
  });
  it('通过时先持久化任务，提交后删除；删除成功才记录 DELETED', async () => {
    const events: string[] = [];
    prisma.$transaction.mockImplementation(async (fn: any) => {
      const result = await fn(prisma);
      events.push('commit');
      return result;
    });
    prisma.campusCardAsset.updateMany.mockImplementation(async ({ data }: any) => {
      if (data.deleteAfter) events.push('enqueue');
      return { count: 1 };
    });
    store.remove.mockImplementation(async () => {
      events.push('delete');
    });
    await service.review('m1', { decision: 'APPROVED', version: 2 }, 'admin');
    expect(events).toEqual(['enqueue', 'commit', 'delete']);
    expect(prisma.campusCardAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'DELETED', deletedAt: expect.any(Date) }),
      }),
    );
  });
  it('存储删除失败仍保留审核结果及重试任务，不虚报删除完成', async () => {
    store.remove.mockRejectedValue(new Error('storage unavailable'));
    await service.review('m1', { decision: 'APPROVED', version: 2 }, 'admin');
    expect(prisma.memberAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ verificationStatus: 'APPROVED' }),
      }),
    );
    expect(prisma.campusCardAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextAttemptAt: expect.any(Date), leaseUntil: null }),
      }),
    );
    expect(
      prisma.campusCardAsset.update.mock.calls.some(([arg]: any[]) => arg.data.state === 'DELETED'),
    ).toBe(false);
  });
  it('事务失败不会删除尚未通过的材料', async () => {
    prisma.$transaction.mockRejectedValue(new Error('rollback'));
    await expect(
      service.review('m1', { decision: 'APPROVED', version: 2 }, 'admin'),
    ).rejects.toThrow('rollback');
    expect(store.remove).not.toHaveBeenCalled();
  });
  it('拒绝旧版本审核和缺少材料的申请', async () => {
    await expect(
      service.review('m1', { decision: 'APPROVED', version: 1 }, 'admin'),
    ).rejects.toThrow(ConflictException);
    prisma.campusCardAsset.findFirst.mockResolvedValue(null);
    await expect(
      service.review('m1', { decision: 'APPROVED', version: 2 }, 'admin'),
    ).rejects.toThrow('没有有效校园卡');
  });
  it('退回必须写原因且不会通过审核', async () => {
    await expect(
      service.review('m1', { decision: 'CHANGES_REQUESTED', version: 2, reason: '  ' }, 'admin'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('材料缺失或过期时仍可退回补充，不能因此通过审核', async () => {
    prisma.campusCardAsset.findFirst.mockResolvedValue(null);
    await service.review(
      'm1',
      { decision: 'CHANGES_REQUESTED', version: 2, reason: '材料缺失，请重新提交' },
      'admin',
    );
    expect(prisma.memberAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationStatus: 'CHANGES_REQUESTED',
          reviewComment: '材料缺失，请重新提交',
        }),
      }),
    );
    expect(store.remove).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REVIEW_CAMPUS_CARD' }),
      }),
    );
  });
  it('通过后即使对象删除失败也不能预览', async () => {
    prisma.memberAccount.findUnique.mockResolvedValue({
      ...member,
      verificationStatus: 'APPROVED',
    });
    await expect(service.preview('m1', 'a1', 'admin')).rejects.toThrow(NotFoundException);
    expect(store.read).not.toHaveBeenCalled();
  });
  it('读取期间通过审核也拒绝返回图片', async () => {
    prisma.memberAccount.count.mockResolvedValue(0);
    await expect(service.preview('m1', 'a1', 'admin')).rejects.toThrow(NotFoundException);
  });
  it('并发清理未获得租约不删除；过期租约可重试', async () => {
    prisma.campusCardAsset.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.cleanup()).toEqual({ attempted: 1, deleted: 0 });
    expect(store.remove).not.toHaveBeenCalled();
    prisma.campusCardAsset.updateMany.mockResolvedValue({ count: 1 });
    expect((await service.cleanup()).deleted).toBe(1);
  });
  it('25 条未决记录重试后让出名额，不饿死后面的正常删除', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({
      id: `queue-${i}`, objectKey: `queue-${i}`, state: 'DELETE_PENDING',
      uploadSettled: i === 25, memberId: null,
      deleteAfter: new Date(i), nextAttemptAt: new Date(i), leaseUntil: null,
    }));
    prisma.campusCardAsset.findMany.mockImplementation(async ({ orderBy, take }: any) => {
      expect(orderBy).toEqual([{ nextAttemptAt: 'asc' }, { deleteAfter: 'asc' }, { id: 'asc' }]);
      return rows.filter(r => r.state !== 'DELETED')
        .sort((a, b) => +a.nextAttemptAt - +b.nextAttemptAt).slice(0, take).map(r => ({ ...r }));
    });
    prisma.campusCardAsset.update.mockImplementation(async ({ where, data }: any) =>
      Object.assign(rows.find(r => r.id === where.id)!, data));
    expect((await service.cleanup()).deleted).toBe(0);
    // Even when the unresolved items become due again, the untouched row is older.
    expect((await service.cleanup()).deleted).toBe(1);
    expect(rows.find(r => r.id === 'queue-25')?.state).toBe('DELETED');
    expect(rows.filter(r => r.state !== 'DELETED')).toHaveLength(25);
  });
  it('没有校园卡不能创建账号', async () => {
    prisma.memberAccount.findUnique.mockResolvedValue(null);
    store.normalize.mockRejectedValue(new BadRequestException('请上传校园卡'));
    await expect(
      service.register({
        username: 'student',
        password: 'A-long-campus-secret!2026',
        realName: '学生',
        studentId: '20260001',
        consentVersion: 'campus-card-v1',
      }),
    ).rejects.toThrow('请上传校园卡');
    expect(prisma.memberAccount.create).not.toHaveBeenCalled();
  });
  it('撤销会话或停用后不能通过凭证校验', async () => {
    expect(
      await service.validate({
        userId: 'm1',
        accountType: 'member',
        aud: 'member',
        sessionVersion: -1,
      }),
    ).toBeNull();
    prisma.memberAccount.findUnique.mockResolvedValue({ ...member, disabled: true });
    expect(
      await service.validate({
        userId: 'm1',
        accountType: 'member',
        aud: 'member',
        sessionVersion: 0,
      }),
    ).toBeNull();
    expect(
      await service.validate({
        userId: 'm1',
        accountType: 'staff',
        aud: 'staff',
        sessionVersion: 0,
      }),
    ).toBeNull();
  });
  it('补交材料验证：已通过或停用拒绝，并发冲突拒绝，正常补交递增版本并重置状态', async () => {
    prisma.memberAccount.findUniqueOrThrow.mockResolvedValueOnce({
      ...member,
      disabled: true,
    });
    await expect(
      service.resubmit('m1', { realName: '新名字', studentId: '20260002', consentVersion: 'v1' }),
    ).rejects.toThrow('当前账号不能补交材料');

    prisma.memberAccount.findUniqueOrThrow.mockResolvedValueOnce({
      ...member,
      verificationStatus: 'APPROVED',
    });
    await expect(
      service.resubmit('m1', { realName: '新名字', studentId: '20260002', consentVersion: 'v1' }),
    ).rejects.toThrow('当前账号不能补交材料');

    // 正常补交
    prisma.memberAccount.findUniqueOrThrow.mockResolvedValue({ ...member });
    prisma.campusCardAsset.create.mockResolvedValue({ id: 'a2', objectKey: 'campus-cards/a2.webp' });
    prisma.memberAccount.updateMany.mockResolvedValue({ count: 1 });
    prisma.campusCardAsset.updateMany.mockResolvedValue({ count: 1 });
    prisma.campusCardAsset.update.mockResolvedValue({ id: 'a2' });

    const result = await service.resubmit('m1', {
      realName: '新名字',
      studentId: '20260002',
      consentVersion: 'v1',
    });
    expect(result).toEqual({ success: true });
    expect(prisma.memberAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'm1',
          disabled: false,
          verificationVersion: 2,
          verificationStatus: { not: 'APPROVED' },
        }),
        data: expect.objectContaining({
          verificationStatus: 'PENDING',
          verificationVersion: 3,
        }),
      }),
    );
    expect(prisma.campusCardAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'a2' }),
        data: expect.objectContaining({
          memberId: 'm1',
          state: 'READY',
          version: 3,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'MEMBER_RESUBMIT' }),
      }),
    );
  });
  it('停用/启用账号：执行数组事务，递增 sessionVersion 并写入审计日志', async () => {
    prisma.memberAccount.update.mockResolvedValue({ id: 'm1' });
    prisma.auditLog.create.mockResolvedValue({ id: 'log1' });

    const disableResult = await service.setDisabled('m1', true, 'admin_user');
    expect(disableResult).toEqual({ success: true });
    expect(prisma.memberAccount.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { disabled: true, sessionVersion: { increment: 1 } },
      select: { id: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        username: 'admin_user',
        action: 'MEMBER_STATUS',
        details: '账号 m1；停用 true',
      },
    });

    const enableResult = await service.setDisabled('m1', false, 'admin_user');
    expect(enableResult).toEqual({ success: true });
    expect(prisma.memberAccount.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { disabled: false, sessionVersion: { increment: 1 } },
      select: { id: true },
    });
  });
  it('重置密码：哈希新密码，执行数组事务递增 sessionVersion 并写入审计日志', async () => {
    prisma.memberAccount.update.mockResolvedValue({ id: 'm1' });
    prisma.auditLog.create.mockResolvedValue({ id: 'log2' });

    const result = await service.resetPassword('m1', 'NewSecretPassword!2026', 'admin_user');
    expect(result).toEqual({ success: true });
    expect(prisma.memberAccount.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { password: expect.any(String), sessionVersion: { increment: 1 } },
      select: { id: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        username: 'admin_user',
        action: 'MEMBER_PASSWORD_RESET',
        details: '经人工核验重置账号 m1 (student) 密码并清空账号限流',
      },
    });
  });
  it('用户列表查询：正确执行分页、状态过滤，且学号进行脱敏掩码保护', async () => {
    prisma.memberAccount.count.mockResolvedValue(1);
    prisma.memberAccount.findMany.mockResolvedValue([
      {
        ...member,
        studentId: '2026123456',
        requestedStudentId: '2026654321',
        source: 'SELF_REGISTER',
        createdAt: new Date(),
        reviewedAt: null,
      },
    ]);

    const result = await service.list({ page: 1, limit: 20, status: 'PENDING', search: 'student' });
    expect(result.total).toBe(1);
    expect(result.data[0].studentId).toBe('20****56');
    expect(result.data[0].requestedStudentId).toBe('20****21');
    expect(prisma.memberAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          verificationStatus: 'PENDING',
          OR: [
            { username: { contains: 'student' } },
            { requestedStudentId: { contains: 'student' } },
          ],
        },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('真实 stage/cleanup 交错：未决写入不可释放容量，写入完成后再删除', async () => {
    jest.useFakeTimers();
    let row: any;
    let objectExists = false;
    let finishUpload!: () => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
    const held = new Promise<void>((resolve) => { finishUpload = resolve; });
    const apply = (data: any) => Object.assign(row, data, {
      attempts: typeof data.attempts === 'object' ? row.attempts + data.attempts.increment : row.attempts,
    });
    prisma.campusCardAsset.create.mockImplementation(async ({ data }: any) => {
      row = { id: 'slow', memberId: null, attempts: 0, deletedAt: null, ...data, createdAt: new Date() };
      return { ...row };
    });
    prisma.campusCardAsset.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (typeof where.state === 'string' && row.state !== where.state) return { count: 0 };
      if (where.leaseUntil?.gte && (!row.leaseUntil || row.leaseUntil < where.leaseUntil.gte)) return { count: 0 };
      if (where.OR && row.leaseUntil && row.leaseUntil >= new Date()) return { count: 0 };
      apply(data);
      return { count: 1 };
    });
    prisma.campusCardAsset.update.mockImplementation(async ({ data }: any) => { apply(data); return row; });
    prisma.campusCardAsset.findMany.mockImplementation(async () =>
      row.state !== 'DELETED' && row.deleteAfter <= new Date() &&
      (!row.leaseUntil || row.leaseUntil < new Date()) ? [{ ...row }] : []);
    store.put.mockImplementation(async () => { uploadStarted(); await held; objectExists = true; });
    store.remove.mockImplementation(async () => { objectExists = false; });
    try {
      const upload = (service as any).stage({ buffer: Buffer.from('image') });
      await started;
      jest.setSystemTime(Date.now() + 61_000);
      await service.cleanup();
      expect(row.state).toBe('DELETE_PENDING');
      expect(row.uploadSettled).toBe(false);
      expect(row.deletedAt).toBeNull();
      expect(objectExists).toBe(false);
      finishUpload();
      await expect(upload).rejects.toThrow(ServiceUnavailableException);
      expect(objectExists).toBe(true);
      expect(row.uploadSettled).toBe(true);
      jest.setSystemTime(Date.now() + 61_000);
      await service.cleanup();
      expect(row.state).toBe('DELETED');
      expect(objectExists).toBe(false);
    } finally { finishUpload(); jest.useRealTimers(); }
  });

  it('PUT 结果不明时保留未决标记，不能直接补偿后释放容量', async () => {
    store.put.mockRejectedValue(new Error('network outcome unknown'));
    await expect((service as any).stage({ buffer: Buffer.from('image') })).rejects.toThrow('network outcome unknown');
    expect(prisma.campusCardAsset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ uploadSettled: false }),
    }));
    expect(prisma.campusCardAsset.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ uploadSettled: true }),
    }));
    expect(store.remove).not.toHaveBeenCalled();
  });
});
