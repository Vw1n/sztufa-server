import { BadRequestException } from '@nestjs/common';
import { SeasonDeletionService } from './season-deletion.service';

describe('SeasonDeletionService', () => {
  const prisma = {
    $transaction: jest.fn(),
  };
  const auditLogService = { log: jest.fn() };
  let service: SeasonDeletionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SeasonDeletionService(prisma as any, auditLogService as any);
  });

  const season = {
    id: 'season-1',
    name: '2026 春季赛',
    _count: { matches: 2, teamPlayers: 30, groupTeams: 0 },
  };

  const createTransaction = (
    approvers: Array<{ id: string; username: string }>,
    approverRole = 'super_admin',
    seasonExists = true,
  ) => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          username: 'admin1',
          role: approverRole,
        }),
      },
      season: {
        findUnique: jest.fn().mockResolvedValue(seasonExists ? season : null),
        delete: jest.fn().mockResolvedValue({ id: season.id }),
      },
      seasonDeletionApproval: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue(
          approvers.map((approver, index) => ({
            createdAt: new Date(`2026-07-24T00:0${index}:00Z`),
            approver: { ...approver, role: 'super_admin' },
          })),
        ),
      },
      match: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    return tx;
  };

  it('缺少审批人 ID 时抛出 BadRequestException', async () => {
    await expect(
      service.approveSeasonDeletion('season-1', undefined, 'admin1'),
    ).rejects.toThrow('无法识别审批人，请重新登录');
  });

  it('非超级管理员审批时抛出 BadRequestException', async () => {
    createTransaction([], 'user');
    await expect(
      service.approveSeasonDeletion('season-1', 'user-1', 'user1'),
    ).rejects.toThrow('只有超级管理员可以审批删除赛季');
  });

  it('目标赛季不存在时抛出 BadRequestException', async () => {
    createTransaction([], 'super_admin', false);
    await expect(
      service.approveSeasonDeletion('season-1', 'admin-1', 'admin1'),
    ).rejects.toThrow('赛季不存在');
  });

  it('1 个超级管理员审批时记录进度 (pending: true) 并且不删除赛季', async () => {
    const tx = createTransaction([{ id: 'admin-1', username: 'admin1' }]);
    const result = await service.approveSeasonDeletion('season-1', 'admin-1', 'admin1');

    expect(result.success).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.approval?.approvedCount).toBe(1);
    expect(result.approval?.requiredCount).toBe(3);
    expect(tx.season.delete).not.toHaveBeenCalled();
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin1',
      'APPROVE_DELETE_SEASON',
      expect.stringContaining('1/3'),
    );
  });

  it('达到 3 个超级管理员审批后物理删除赛季并写日志 (pending: false)', async () => {
    const tx = createTransaction([
      { id: 'admin-1', username: 'admin1' },
      { id: 'admin-2', username: 'admin2' },
      { id: 'admin-3', username: 'admin3' },
    ]);
    const result = await service.approveSeasonDeletion('season-1', 'admin-3', 'admin3');

    expect(result.success).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.deleted?.id).toBe('season-1');
    expect(tx.match.deleteMany).toHaveBeenCalledWith({ where: { seasonId: 'season-1' } });
    expect(tx.season.delete).toHaveBeenCalledWith({ where: { id: 'season-1' } });
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin3',
      'DELETE_SEASON',
      expect.stringContaining('三名超级管理员审批通过'),
    );
  });
});
