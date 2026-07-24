import { describe, expect, it, jest } from '@jest/globals';
import { SeasonStatisticsService } from './season-statistics.service';
import { LeagueStandingsCalculator } from './league-standings.calculator';
import { CupStandingsCalculator } from './cup-standings.calculator';
import { PlayerStatisticsCalculator } from './player-statistics.calculator';

describe('SeasonStatisticsService', () => {
  const createPrisma = () => ({
    season: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    match: { findMany: jest.fn() },
    seasonTeamPlayer: { findMany: jest.fn() },
    seasonGroupTeam: { findMany: jest.fn() },
    team: { findMany: jest.fn() },
    player: { findMany: jest.fn() },
  });

  const createService = (prisma: any) => {
    const leagueCalculator = new LeagueStandingsCalculator();
    const cupCalculator = new CupStandingsCalculator(prisma);
    const playerStatsCalculator = new PlayerStatisticsCalculator(prisma);
    return new SeasonStatisticsService(
      prisma,
      leagueCalculator,
      cupCalculator,
      playerStatsCalculator,
    );
  };

  it('保持联赛积分榜和球员统计的计算规则', async () => {
    const prisma: any = createPrisma();
    prisma.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯男子组',
      type: 'LEAGUE',
    });
    prisma.match.findMany.mockResolvedValue([
      {
        homeTeamId: 'home',
        awayTeamId: 'away',
        homeScore: 2,
        awayScore: 1,
        stage: 'LEAGUE',
        goals: [
          {
            playerId: 'player-1',
            playerName: '前锋 (点球)',
            jerseyNumber: '9',
            teamType: 'home',
          },
          {
            playerId: null,
            playerName: '后卫 (乌龙)',
            jerseyNumber: '4',
            teamType: 'away',
          },
        ],
        events: [
          {
            playerId: 'player-2',
            playerName: '后卫',
            jerseyNumber: '4',
            teamType: 'away',
            eventType: 'yellow_card',
            assistPlayerId: 'player-1',
            assistPlayerName: '前锋',
            assistJerseyNumber: '9',
          },
        ],
      },
    ]);
    const home = { id: 'home', teamName: '主队', teamLogo: 'home.png', gender: 'MALE' };
    const away = { id: 'away', teamName: '客队', teamLogo: 'away.png', gender: 'MALE' };
    prisma.seasonTeamPlayer.findMany.mockResolvedValue([
      { teamId: 'home', team: home },
      { teamId: 'away', team: away },
    ]);
    prisma.team.findMany.mockResolvedValue([home, away]);
    prisma.player.findMany.mockResolvedValue([
      { id: 'player-1', name: '前锋', jerseyNumber: '9', team: home },
      { id: 'player-2', name: '后卫', jerseyNumber: '4', team: away },
    ]);
    prisma.season.update.mockResolvedValue({});

    await createService(prisma).computeAndCache('season-1');

    expect(prisma.season.update).toHaveBeenCalledWith({
      where: { id: 'season-1' },
      data: {
        standingsCache: [
          expect.objectContaining({ teamId: 'home', played: 1, won: 1, points: 3 }),
          expect.objectContaining({ teamId: 'away', played: 1, lost: 1, points: 0 }),
        ],
        statsCache: {
          scorers: [expect.objectContaining({ playerId: 'player-1', goals: 1 })],
          assists: [expect.objectContaining({ playerId: 'player-1', assists: 1 })],
          cards: [expect.objectContaining({ playerId: 'player-2', yellowCards: 1 })],
        },
      },
    });
  });

  it('保持杯赛按小组输出和排序', async () => {
    const prisma: any = createPrisma();
    const teamA = { id: 'a', teamName: 'A队', teamLogo: '', gender: 'FEMALE' };
    const teamB = { id: 'b', teamName: 'B队', teamLogo: '', gender: 'FEMALE' };
    prisma.season.findUnique.mockResolvedValue({
      id: 'cup-1',
      name: '2026女子组',
      type: 'CUP',
    });
    prisma.match.findMany.mockResolvedValue([
      {
        homeTeamId: 'a',
        awayTeamId: 'b',
        homeScore: 0,
        awayScore: 0,
        stage: 'GROUP',
        groupName: 'A',
        goals: [],
        events: [],
      },
    ]);
    prisma.seasonTeamPlayer.findMany.mockResolvedValue([]);
    prisma.seasonGroupTeam.findMany.mockResolvedValue([
      { teamId: 'a', groupName: 'A', team: teamA },
      { teamId: 'b', groupName: 'A', team: teamB },
    ]);
    prisma.team.findMany.mockResolvedValue([teamA, teamB]);
    prisma.player.findMany.mockResolvedValue([]);
    prisma.season.update.mockResolvedValue({});

    await createService(prisma).computeAndCache('cup-1');

    expect(prisma.season.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          standingsCache: {
            type: 'CUP',
            groups: {
              A: [
                expect.objectContaining({ teamId: 'a', drawn: 1, points: 1 }),
                expect.objectContaining({ teamId: 'b', drawn: 1, points: 1 }),
              ],
            },
          },
        }),
      }),
    );
  });

  it('赛季不存在时不写入缓存', async () => {
    const prisma: any = createPrisma();
    prisma.season.findUnique.mockResolvedValue(null);

    const result = await createService(prisma).computeAndCache('missing');

    expect(prisma.season.update).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '赛季不存在' });
  });
});
