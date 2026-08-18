import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { MatchQueryService } from './match-query.service';

describe('MatchQueryService', () => {
  it('uses the active season and keeps statistics independent from the status filter', async () => {
    const prisma: any = {
      season: {
        findFirst: jest.fn<() => Promise<any>>().mockResolvedValue({ id: 'season-1' }),
      },
      match: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'match-1' }]),
        count: jest.fn<() => Promise<number>>().mockResolvedValue(1),
        groupBy: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          { status: 'finished', _count: { _all: 1 } },
          { status: 'scheduled', _count: { _all: 1 } },
        ]),
      },
    };
    const service = new MatchQueryService(prisma);

    const result = await service.findAll(1, 10, undefined, undefined, 'finished');

    expect(prisma.match.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, seasonId: 'season-1' },
      }),
    );
    expect(prisma.match.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          goals: expect.anything(),
          events: expect.anything(),
          lineups: expect.anything(),
        }),
      }),
    );
    const listQuery = (prisma.match.findMany.mock.calls as any[][])[0][0];
    expect(listQuery.select.homeTeam.select).toEqual({
      id: true,
      teamName: true,
      teamLogo: true,
    });
    expect(result.stats).toEqual({ total: 2, completed: 1, scheduled: 1, ongoing: 0 });
  });

  it('does not return soft-deleted matches', async () => {
    const prisma: any = {
      match: {
        findUnique: jest
          .fn<() => Promise<any>>()
          .mockResolvedValue({ id: 'match-1', deletedAt: new Date() }),
      },
    };
    const service = new MatchQueryService(prisma);

    await expect(service.findOne('match-1')).rejects.toBeInstanceOf(NotFoundException);

    const detailQuery = (prisma.match.findUnique.mock.calls as any[][])[0][0];
    expect(detailQuery.select.lineups.select.player.select).toEqual({
      id: true,
      name: true,
      jerseyNumber: true,
      photo: true,
    });
  });
});
