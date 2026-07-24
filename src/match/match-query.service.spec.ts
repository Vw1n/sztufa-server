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
        findMany: jest
          .fn<() => Promise<any[]>>()
          .mockResolvedValueOnce([{ id: 'match-1' }])
          .mockResolvedValueOnce([{ status: 'finished' }, { status: 'scheduled' }]),
        count: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      },
    };
    const service = new MatchQueryService(prisma);

    const result = await service.findAll(1, 10, undefined, undefined, 'finished');

    expect(prisma.match.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { deletedAt: null, seasonId: 'season-1' },
      }),
    );
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
  });
});
