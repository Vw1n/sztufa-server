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
          scorers: [expect.objectContaining({ playerId: 'player-1', goals: 1, penaltyGoals: 1 })],
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

  it('射手榜与助攻榜准确按比赛主客队归属 郭海(A2联队) 与 李浪(城市交通与物流学院) 及 范嘉俊(新材料与新能源学院)', async () => {
    const prisma: any = createPrisma();
    prisma.seasonTeamProfile = { findMany: jest.fn() };
    prisma.season.findUnique.mockResolvedValue({
      id: 'cmroeexdz00018js1kmbmyog5',
      name: '2026校长杯男子组',
      type: 'CUP',
    });

    // 真实比赛数据模拟
    prisma.match.findMany.mockResolvedValue([
      // 比赛1：工程物理学院 vs A2联队（郭海代表A2联队进球）
      {
        id: 'match-guohai',
        seasonId: 'cmroeexdz00018js1kmbmyog5',
        homeTeamId: 'team-physics',
        awayTeamId: 'team-a2',
        homeScore: 3,
        awayScore: 9,
        stage: 'GROUP',
        groupName: 'B',
        goals: [
          {
            playerId: 'player-guohai',
            playerName: '郭海',
            jerseyNumber: '30',
            teamType: 'away', // 客队是 A2联队
          },
        ],
        events: [],
      },
      // 比赛2：商学院 vs 城市交通与物流学院（李浪代表交通进球）
      {
        id: 'match-lilang',
        seasonId: 'cmroeexdz00018js1kmbmyog5',
        homeTeamId: 'team-business',
        awayTeamId: 'team-traffic',
        homeScore: 1,
        awayScore: 3,
        stage: 'GROUP',
        groupName: 'A',
        goals: [
          {
            playerId: 'player-lilang',
            playerName: '李浪',
            jerseyNumber: '9',
            teamType: 'away', // 客队是 城市交通与物流学院
          },
        ],
        events: [],
      },
      // 比赛3：新材料与新能源学院 vs 大数据与互联网学院（范嘉俊进球）
      {
        id: 'match-fanjiajun',
        seasonId: 'cmroeexdz00018js1kmbmyog5',
        homeTeamId: 'team-materials',
        awayTeamId: 'team-bigdata',
        homeScore: 2,
        awayScore: 2,
        stage: 'KNOCKOUT',
        goals: [
          {
            playerId: 'player-fan',
            playerName: '范嘉俊',
            jerseyNumber: '7',
            teamType: 'home', // 主队是 新材料与新能源学院
          },
        ],
        events: [],
      },
    ]);

    // 赛季球队档案快照
    const profileMaterials = {
      seasonId: 'cmroeexdz00018js1kmbmyog5',
      teamId: 'team-materials',
      teamName: '新材料与新能源学院',
      teamLogo: 'materials.png',
      gender: 'MALE',
    };
    const profileA2 = {
      seasonId: 'cmroeexdz00018js1kmbmyog5',
      teamId: 'team-a2',
      teamName: 'A2联队',
      teamLogo: 'a2.png',
      gender: 'MALE',
    };
    const profileTraffic = {
      seasonId: 'cmroeexdz00018js1kmbmyog5',
      teamId: 'team-traffic',
      teamName: '城市交通与物流学院',
      teamLogo: 'traffic.png',
      gender: 'MALE',
    };

    prisma.seasonTeamProfile.findMany.mockResolvedValue([
      profileMaterials,
      profileA2,
      profileTraffic,
    ]);

    prisma.seasonTeamPlayer.findMany.mockResolvedValue([]);
    prisma.seasonGroupTeam.findMany.mockResolvedValue([]);

    // 数据库全局 Team 表
    prisma.team.findMany.mockResolvedValue([
      { id: 'team-materials', teamName: '新材料与新能源', teamLogo: 'old.png', gender: 'MALE' },
      { id: 'team-a2', teamName: 'A2联队', teamLogo: 'a2.png', gender: 'MALE' },
      {
        id: 'team-traffic',
        teamName: '城市交通与物流学院',
        teamLogo: 'traffic.png',
        gender: 'MALE',
      },
      { id: 'team-physics', teamName: '工程物理学院', teamLogo: 'physics.png', gender: 'MALE' },
      { id: 'team-business', teamName: '商学院', teamLogo: 'business.png', gender: 'MALE' },
      { id: 'team-health', teamName: '健康与环境工程学院', teamLogo: 'health.png', gender: 'MALE' },
      {
        id: 'team-pharmacy',
        teamName: '深圳技术大学药学院',
        teamLogo: 'pharmacy.png',
        gender: 'MALE',
      },
    ]);

    // 数据库全局 Player 表（注意：全局 player.team 关联了历史或转会后的球队）
    prisma.player.findMany.mockResolvedValue([
      {
        id: 'player-guohai',
        name: '郭海',
        jerseyNumber: '30',
        teamId: 'team-health',
        team: { teamName: '健康与环境工程学院', teamLogo: 'health.png' }, // BUG场景：全局是健康学院
      },
      {
        id: 'player-lilang',
        name: '李浪',
        jerseyNumber: '9',
        teamId: 'team-pharmacy',
        team: { teamName: '深圳技术大学药学院', teamLogo: 'pharmacy.png' }, // BUG场景：全局是药学院
      },
      {
        id: 'player-fan',
        name: '范嘉俊',
        jerseyNumber: '7',
        teamId: 'team-materials',
        team: { teamName: '新材料与新能源', teamLogo: 'old.png' }, // BUG场景：全局是旧队名
      },
    ]);
    prisma.season.update.mockResolvedValue({});

    await createService(prisma).computeAndCache('cmroeexdz00018js1kmbmyog5');

    // 验证：射手榜中的所属球队必须根据比赛事件主客队及赛季快照精准归属
    expect(prisma.season.update).toHaveBeenCalledWith({
      where: { id: 'cmroeexdz00018js1kmbmyog5' },
      data: expect.objectContaining({
        statsCache: expect.objectContaining({
          scorers: expect.arrayContaining([
            expect.objectContaining({
              playerName: '郭海',
              teamName: 'A2联队',
              teamLogo: 'a2.png',
            }),
            expect.objectContaining({
              playerName: '李浪',
              teamName: '城市交通与物流学院',
              teamLogo: 'traffic.png',
            }),
            expect.objectContaining({
              playerName: '范嘉俊',
              teamName: '新材料与新能源学院',
              teamLogo: 'materials.png',
            }),
          ]),
        }),
      }),
    });
  });
});
