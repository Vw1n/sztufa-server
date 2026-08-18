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

  it('uses explicit registration and historical season participation instead of legacy team gender', async () => {
    const { service, prisma } = createService();
    prisma.team.findMany.mockResolvedValue([{ id: 'team-1' }]);
    prisma.team.count.mockResolvedValue(1);

    await expect(service.findAll(2, 20, 'season-1', 'MALE')).resolves.toEqual({
      data: [{ id: 'team-1', players: [] }],
      total: 1,
      page: 2,
      limit: 20,
    });

    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        include: expect.objectContaining({
          players: false,
          seasonPlayers: {
            where: { seasonId: 'season-1', player: { deletedAt: null } },
            include: { player: true },
          },
          groupTeams: { where: { seasonId: 'season-1' } },
          seasonProfiles: { where: { seasonId: 'season-1' } },
        }),
        where: {
          deletedAt: null,
          OR: [
            { seasonProfiles: { some: { seasonId: 'season-1', isRegistered: true } } },
            { seasonPlayers: { some: { seasonId: 'season-1' } } },
            { groupTeams: { some: { seasonId: 'season-1' } } },
            { homeMatches: { some: { seasonId: 'season-1' } } },
            { awayMatches: { some: { seasonId: 'season-1' } } },
          ],
        },
      }),
    );
  });

  it('returns players from the selected team roster instead of the global team relation', async () => {
    const { service, prisma } = createService();
    prisma.team.findMany.mockResolvedValue([
      {
        id: 'team-1',
        players: [{ id: 'wrong-player', name: 'Wrong Team Player' }],
        seasonPlayers: [
          {
            teamId: 'team-1',
            playerName: 'Season Player',
            jerseyNumber: '9',
            playerPhoto: 'season.webp',
            player: {
              id: 'season-player',
              name: 'Global Name',
              jerseyNumber: '99',
              photo: 'global.webp',
              teamId: 'other-team',
            },
          },
        ],
        seasonProfiles: [],
      },
    ]);
    prisma.team.count.mockResolvedValue(1);

    const result = await service.findAll(1, 10, 'season-1', 'MALE');

    expect(result.data[0].players).toEqual([
      expect.objectContaining({
        id: 'season-player',
        name: 'Season Player',
        jerseyNumber: '9',
        photo: 'season.webp',
        teamId: 'team-1',
      }),
    ]);
    expect(result.data[0].players).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'wrong-player' })]),
    );
  });

  it('overlays season-specific team details without leaking the global profile', async () => {
    const { service, prisma } = createService();
    prisma.team.findMany.mockResolvedValue([
      {
        id: 'team-1',
        teamName: '测试队',
        headCoach: '当前教练',
        teamLogo: 'current.png',
        players: [],
        groupTeams: [],
        seasonProfiles: [
          {
            teamName: '测试队',
            teamDoctor: null,
            headCoach: null,
            teamLeader: null,
            coachPhone: null,
            leaderPhone: null,
            homeJerseyColor: '未记录',
            awayJerseyColor: '未记录',
            teamLogo: null,
            homeJersey: null,
            awayJersey: null,
            gender: 'MALE',
          },
        ],
      },
    ]);
    prisma.team.count.mockResolvedValue(1);

    const result = await service.findAll(1, 10, 'season-1', 'MALE');

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        teamName: '测试队',
        headCoach: null,
        teamLogo: null,
        homeJerseyColor: '未记录',
      }),
    );
    expect(result.data[0]).not.toHaveProperty('seasonProfiles');
  });

  it('keeps the not-found behavior for deleted teams', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: new Date() });

    await expect(service.findOne('team-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not include player rosters in the public team list', async () => {
    const { service, prisma } = createService();
    prisma.team.findMany.mockResolvedValue([{ id: 'team-1', seasonProfiles: [] }]);
    prisma.team.count.mockResolvedValue(1);

    const result = await service.findPublicAll(1, 10, 'season-1');

    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          players: expect.anything(),
          seasonPlayers: expect.anything(),
        }),
      }),
    );
    expect(result.data[0]).not.toHaveProperty('players');
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
