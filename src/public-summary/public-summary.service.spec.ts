import { PublicSummaryService } from './public-summary.service';

describe('PublicSummaryService', () => {
  it('returns scalar counts without loading full records', async () => {
    const prisma: any = {
      match: { count: jest.fn().mockResolvedValue(42) },
      player: { count: jest.fn().mockResolvedValue(300) },
      team: { count: jest.fn().mockResolvedValue(16) },
    };
    const service = new PublicSummaryService(prisma);

    await expect(service.getSummary()).resolves.toEqual({
      matchCount: 42,
      playerCount: 300,
      teamCount: 16,
    });
    expect(prisma.match.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.player.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.team.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });
});
