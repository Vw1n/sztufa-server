import { BadRequestException } from '@nestjs/common';
import { SeasonService } from './season.service';

describe('SeasonService', () => {
  const prisma = {
    season: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const auditLogService = { log: jest.fn() };
  let service: SeasonService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SeasonService(prisma as any, auditLogService as any, {} as any);
  });

  describe('renameSeason', () => {
    it('rejects an empty name', async () => {
      await expect(service.renameSeason('season-1', '   ', 'admin')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a duplicate name', async () => {
      prisma.season.findUnique.mockResolvedValue({ id: 'season-1', name: '旧名称' });
      prisma.season.findFirst.mockResolvedValue({ id: 'season-2' });
      await expect(service.renameSeason('season-1', '已有赛季', 'admin')).rejects.toThrow(
        '赛季名称 "已有赛季" 已存在',
      );
    });

    it('renames the season and writes an audit log', async () => {
      prisma.season.findUnique.mockResolvedValue({ id: 'season-1', name: '旧名称' });
      prisma.season.findFirst.mockResolvedValue(null);
      prisma.season.update.mockResolvedValue({ id: 'season-1', name: '新名称' });
      await expect(service.renameSeason('season-1', ' 新名称 ', 'admin')).resolves.toEqual({
        id: 'season-1',
        name: '新名称',
      });
      expect(auditLogService.log).toHaveBeenCalledWith(
        'admin',
        'RENAME_SEASON',
        expect.stringContaining('新名称'),
      );
    });
  });

  describe('approveSeasonDeletion', () => {
    const season = {
      id: 'season-1',
      name: '2026 春季赛',
      _count: { matches: 2, teamPlayers: 30, groupTeams: 0 },
    };

    const createTransaction = (approvers: Array<{ id: string; username: string }>) => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'admin-1',
            username: 'admin1',
            role: 'super_admin',
          }),
        },
        season: {
          findUnique: jest.fn().mockResolvedValue(season),
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

    it('records one approval without deleting the season', async () => {
      const tx = createTransaction([{ id: 'admin-1', username: 'admin1' }]);
      await expect(
        service.approveSeasonDeletion('season-1', 'admin-1', 'admin1'),
      ).resolves.toMatchObject({
        success: true,
        pending: true,
        approval: { approvedCount: 1, requiredCount: 3 },
      });
      expect(tx.seasonDeletionApproval.upsert).toHaveBeenCalledWith({
        where: { seasonId_approverId: { seasonId: 'season-1', approverId: 'admin-1' } },
        update: {},
        create: { seasonId: 'season-1', approverId: 'admin-1' },
      });
      expect(tx.season.delete).not.toHaveBeenCalled();
    });

    it('deletes only after three different super admins approve', async () => {
      const tx = createTransaction([
        { id: 'admin-1', username: 'admin1' },
        { id: 'admin-2', username: 'admin2' },
        { id: 'admin-3', username: 'admin3' },
      ]);
      await expect(
        service.approveSeasonDeletion('season-1', 'admin-3', 'admin3'),
      ).resolves.toMatchObject({
        success: true,
        pending: false,
        deleted: { id: 'season-1', matches: 2 },
      });
      expect(tx.match.deleteMany).toHaveBeenCalledWith({ where: { seasonId: 'season-1' } });
      expect(tx.season.delete).toHaveBeenCalledWith({ where: { id: 'season-1' } });
    });

    it('rejects an approver who is no longer a super admin', async () => {
      const tx = createTransaction([]);
      tx.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        username: 'admin1',
        role: 'user',
      });
      await expect(service.approveSeasonDeletion('season-1', 'admin-1', 'admin1')).rejects.toThrow(
        '只有超级管理员可以审批删除赛季',
      );
    });
  });
});
