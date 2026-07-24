import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { TeamQueryService } from './team-query.service';

describe('TeamQueryService', () => {
  const createService = () => {
    const prisma: any = {
      team: {
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    return { service: new TeamQueryService(prisma), prisma };
  };

  it('keeps pagination, gender and season filters unchanged', async () => {
    const { service, prisma } = createService();
    prisma.team.findMany.mockResolvedValue([{ id: 'team-1' }]);
    prisma.team.count.mockResolvedValue(1);

    await expect(service.findAll(2, 20, 'season-1', 'MALE')).resolves.toEqual({
      data: [{ id: 'team-1' }],
      total: 1,
      page: 2,
      limit: 20,
    });

    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        where: expect.objectContaining({
          deletedAt: null,
          gender: 'MALE',
          OR: expect.arrayContaining([{ seasonPlayers: { some: { seasonId: 'season-1' } } }]),
        }),
      }),
    );
  });

  it('keeps the not-found behavior for deleted teams', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: new Date() });

    await expect(service.findOne('team-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('trims searches and returns no results for an empty name', async () => {
    const { service, prisma } = createService();
    await expect(service.searchByName('  ')).resolves.toEqual([]);
    expect(prisma.team.findMany).not.toHaveBeenCalled();

    prisma.team.findMany.mockResolvedValue([{ id: 'team-1' }]);
    await service.searchByName(' 测试 ');
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamName: { contains: '测试' }, deletedAt: null },
      }),
    );
  });
});
