import { PlayerService } from '../player/player.service';
import { TeamQueryService } from '../team/team-query.service';

describe('public database query projections', () => {
  it('selects only public player and nested team fields', async () => {
    const prisma: any = {
      player: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new PlayerService(prisma, { log: jest.fn() } as any);

    await service.findPublicAll(undefined, 1, 10);

    const query = prisma.player.findMany.mock.calls[0][0];
    expect(query.select.studentId).toBeUndefined();
    expect(query.select.legacyKey).toBeUndefined();
    expect(query.select.deletedAt).toBeUndefined();
    expect(query.select.team.select.coachPhone).toBeUndefined();
    expect(query.select.team.select.leaderPhone).toBeUndefined();
  });

  it('keeps private team and roster fields out of public team lists', async () => {
    const prisma: any = {
      team: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new TeamQueryService(prisma);

    await service.findPublicAll(1, 10, 'season-1');

    const query = prisma.team.findMany.mock.calls[0][0];
    expect(query.select.coachPhone).toBeUndefined();
    expect(query.select.leaderPhone).toBeUndefined();
    expect(query.select.seasonProfiles.select.coachPhone).toBeUndefined();
    expect(query.select.players).toBe(false);
    expect(query.select.seasonPlayers).toBe(false);
  });
});
