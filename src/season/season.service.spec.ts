import { BadRequestException } from '@nestjs/common';
import { SeasonService } from './season.service';

describe('SeasonService', () => {
  const prisma = {
    season: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const auditLogService = {
    log: jest.fn(),
  };
  const seasonStatistics = {};

  let service: SeasonService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SeasonService(
      prisma as any,
      auditLogService as any,
      seasonStatistics as any,
    );
  });

  describe('renameSeason', () => {
    it('rejects an empty name', async () => {
      await expect(service.renameSeason('season-1', '   ', 'admin')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a duplicate name', async () => {
      prisma.season.findUnique.mockResolvedValue({
        id: 'season-1',
        name: '旧名称',
      });
      prisma.season.findFirst.mockResolvedValue({ id: 'season-2' });

      await expect(
        service.renameSeason('season-1', '已有赛季', 'admin'),
      ).rejects.toThrow('赛季名称 "已有赛季" 已存在');
    });

    it('renames the season and writes an audit log', async () => {
      prisma.season.findUnique.mockResolvedValue({
        id: 'season-1',
        name: '旧名称',
      });
      prisma.season.findFirst.mockResolvedValue(null);
      prisma.season.update.mockResolvedValue({
        id: 'season-1',
        name: '新名称',
      });

      await expect(
        service.renameSeason('season-1', ' 新名称 ', 'admin'),
      ).resolves.toEqual({ id: 'season-1', name: '新名称' });
      expect(prisma.season.update).toHaveBeenCalledWith({
        where: { id: 'season-1' },
        data: { name: '新名称' },
      });
      expect(auditLogService.log).toHaveBeenCalledWith(
        'admin',
        'RENAME_SEASON',
        expect.stringContaining('新名称'),
      );
    });
  });

  describe('deleteSeason', () => {
    it('deletes matches before the season in one transaction', async () => {
      prisma.season.findUnique.mockResolvedValue({
        id: 'season-1',
        name: '2026春季赛季',
        _count: { matches: 2, teamPlayers: 30, groupTeams: 0 },
      });
      const tx = {
        match: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
        season: { delete: jest.fn().mockResolvedValue({ id: 'season-1' }) },
      };
      prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      );

      await expect(service.deleteSeason('season-1', 'admin')).resolves.toEqual({
        success: true,
        deleted: {
          id: 'season-1',
          name: '2026春季赛季',
          matches: 2,
          teamPlayers: 30,
          groupTeams: 0,
        },
      });
      expect(tx.match.deleteMany).toHaveBeenCalledWith({
        where: { seasonId: 'season-1' },
      });
      expect(tx.season.delete).toHaveBeenCalledWith({
        where: { id: 'season-1' },
      });
      expect(auditLogService.log).toHaveBeenCalledWith(
        'admin',
        'DELETE_SEASON',
        expect.stringContaining('2 场比赛'),
      );
    });
  });
});
