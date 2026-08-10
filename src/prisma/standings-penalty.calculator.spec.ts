import { describe, expect, it } from '@jest/globals';
import { LeagueStandingsCalculator } from './league-standings.calculator';
import { CupStandingsCalculator } from './cup-standings.calculator';

describe('StandingsCalculators - Penalty Shootout Points', () => {
  const teamsMap = new Map([
    ['team-1', { id: 'team-1', teamName: 'Team 1', teamLogo: '' }],
    ['team-2', { id: 'team-2', teamName: 'Team 2', teamLogo: '' }],
  ]);

  describe('LeagueStandingsCalculator', () => {
    const calculator = new LeagueStandingsCalculator();

    it('awards 3 points for regular win and 0 for loss', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 2,
          awayScore: 1,
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.won).toBe(1);
      expect(team1.points).toBe(3);
      expect(team2.lost).toBe(1);
      expect(team2.points).toBe(0);
    });

    it('awards 1 point each for regular draw without penalty shootout', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.drawn).toBe(1);
      expect(team1.points).toBe(1);
      expect(team2.drawn).toBe(1);
      expect(team2.points).toBe(1);
    });

    it('awards 2 points for penalty win and 0 for penalty loss (via homePenaltyScore/awayPenaltyScore)', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
          homePenaltyScore: 4,
          awayPenaltyScore: 3,
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.drawn).toBe(1);
      expect(team1.points).toBe(2);
      expect(team2.drawn).toBe(1);
      expect(team2.points).toBe(0);
    });

    it('awards 2 points to away team on penalty win and 0 to home team', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 0,
          awayScore: 0,
          homePenaltyScore: 2,
          awayPenaltyScore: 4,
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(0);
      expect(team2.points).toBe(2);
    });

    it('awards 2 points for penalty win via decidedBy and winnerTeamId', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 2,
          awayScore: 2,
          decidedBy: 'PENALTIES',
          winnerTeamId: 'team-1',
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(2);
      expect(team2.points).toBe(0);
    });

    it('awards 1 point each for regular draw with leftover winnerTeamId (not PENALTIES)', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
          decidedBy: 'REGULAR',
          winnerTeamId: 'team-1', // 残留的旧 winnerTeamId，但非点球战
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.drawn).toBe(1);
      expect(team1.points).toBe(1);
      expect(team2.drawn).toBe(1);
      expect(team2.points).toBe(1);
    });

    it('awards 1 point each for regular draw with homePenaltyScore=0 & awayPenaltyScore=0 + leftover winnerTeamId', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
          homePenaltyScore: 0,
          awayPenaltyScore: 0,
          decidedBy: 'REGULAR',
          winnerTeamId: 'team-1',
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(1);
      expect(team2.points).toBe(1);
    });

    it('awards 1 point each for regular draw with tied penalty shootout events + leftover winnerTeamId', () => {
      const matches = [
        {
          stage: 'LEAGUE',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 0,
          awayScore: 0,
          decidedBy: 'REGULAR',
          winnerTeamId: 'team-1',
          events: [
            { eventType: 'penalty_shootout_goal', teamType: 'home' },
            { eventType: 'penalty_shootout_goal', teamType: 'away' },
          ],
        },
      ];
      const standings = calculator.calculate(matches, teamsMap);
      const team1 = standings.find((s) => s.teamId === 'team-1')!;
      const team2 = standings.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(1);
      expect(team2.points).toBe(1);
    });

    it('ranks team with H2H win higher when points, GD, and GF are identical', () => {
      const H2HTeamsMap = new Map([
        ['team-a', { id: 'team-a', teamName: 'A队', teamLogo: '' }],
        ['team-b', { id: 'team-b', teamName: 'B队', teamLogo: '' }],
        ['team-x', { id: 'team-x', teamName: 'X队', teamLogo: '' }],
        ['team-y', { id: 'team-y', teamName: 'Y队', teamLogo: '' }],
      ]);
      // A 和 B 均累积 6分、+2 净胜球、4 进球
      const matches = [
        { stage: 'LEAGUE', homeTeamId: 'team-a', awayTeamId: 'team-b', homeScore: 2, awayScore: 0 },
        { stage: 'LEAGUE', homeTeamId: 'team-b', awayTeamId: 'team-a', homeScore: 1, awayScore: 0 },
        { stage: 'LEAGUE', homeTeamId: 'team-a', awayTeamId: 'team-x', homeScore: 2, awayScore: 1 },
        { stage: 'LEAGUE', homeTeamId: 'team-b', awayTeamId: 'team-y', homeScore: 3, awayScore: 0 },
      ];
      const standings = calculator.calculate(matches, H2HTeamsMap);
      // team-a 和 team-b 积分(6分)，GD(+2)，GF(4) 完全相同
      // 小联赛 H2H: A 对 B 相互净胜球 +1 vs B 的 -1
      // 因此 A 排名第一，且与 B 不处于未决平局 (isTiedWithNext = false)
      expect(standings[0].teamId).toBe('team-a');
      expect(standings[0].isTiedWithNext).toBe(false);
      expect(standings[1].teamId).toBe('team-b');
    });

    it('marks isTiedWithNext = true in a 3-team circular tie (A beats B, B beats C, C beats A)', () => {
      const H2HTeamsMap = new Map([
        ['team-a', { id: 'team-a', teamName: 'A队', teamLogo: '' }],
        ['team-b', { id: 'team-b', teamName: 'B队', teamLogo: '' }],
        ['team-c', { id: 'team-c', teamName: 'C队', teamLogo: '' }],
      ]);
      // A 胜 B 1:0, B 胜 C 1:0, C 胜 A 1:0
      // 3队积分均为3，GD均为0，GF均为1，小联赛相互积分/GD/GF亦完全相同！
      const matches = [
        { stage: 'LEAGUE', homeTeamId: 'team-a', awayTeamId: 'team-b', homeScore: 1, awayScore: 0 },
        { stage: 'LEAGUE', homeTeamId: 'team-b', awayTeamId: 'team-c', homeScore: 1, awayScore: 0 },
        { stage: 'LEAGUE', homeTeamId: 'team-c', awayTeamId: 'team-a', homeScore: 1, awayScore: 0 },
      ];
      const standings = calculator.calculate(matches, H2HTeamsMap);

      expect(standings.length).toBe(3);
      expect(standings[0].isTiedWithNext).toBe(true);
      expect(standings[1].isTiedWithNext).toBe(true);
      expect(standings[2].isTiedWithNext).toBe(false);
    });
  });

  describe('CupStandingsCalculator', () => {
    it('calculates group standings with penalty shootout points correctly', async () => {
      const mockPrisma: any = {
        seasonGroupTeam: {
          findMany: jest.fn().mockResolvedValue([
            {
              groupName: 'A',
              teamId: 'team-1',
              team: { id: 'team-1', teamName: 'Team 1', teamLogo: '', gender: 'MALE' },
            },
            {
              groupName: 'A',
              teamId: 'team-2',
              team: { id: 'team-2', teamName: 'Team 2', teamLogo: '', gender: 'MALE' },
            },
          ]),
        },
      };

      const calculator = new CupStandingsCalculator(mockPrisma);
      const matches = [
        {
          stage: 'GROUP',
          groupName: 'A',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
          homePenaltyScore: 5,
          awayPenaltyScore: 4,
        },
      ];

      const result = await calculator.calculate(
        'season-1',
        'MALE',
        matches,
        new Map([
          ['team-1', { id: 'team-1', teamName: 'Team 1', gender: 'MALE' }],
          ['team-2', { id: 'team-2', teamName: 'Team 2', gender: 'MALE' }],
        ]),
      );

      const groupA = result.groups['A'];
      const team1 = groupA.find((s) => s.teamId === 'team-1')!;
      const team2 = groupA.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(2);
      expect(team2.points).toBe(0);
    });

    it('awards 1 point each in cup group stage for draw with 0:0 penalties and leftover winnerTeamId', async () => {
      const mockPrisma: any = {
        seasonGroupTeam: {
          findMany: jest.fn().mockResolvedValue([
            {
              groupName: 'A',
              teamId: 'team-1',
              team: { id: 'team-1', teamName: 'Team 1', teamLogo: '', gender: 'MALE' },
            },
            {
              groupName: 'A',
              teamId: 'team-2',
              team: { id: 'team-2', teamName: 'Team 2', teamLogo: '', gender: 'MALE' },
            },
          ]),
        },
      };

      const calculator = new CupStandingsCalculator(mockPrisma);
      const matches = [
        {
          stage: 'GROUP',
          groupName: 'A',
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeScore: 1,
          awayScore: 1,
          homePenaltyScore: 0,
          awayPenaltyScore: 0,
          decidedBy: 'REGULAR',
          winnerTeamId: 'team-1',
        },
      ];

      const result = await calculator.calculate(
        'season-1',
        'MALE',
        matches,
        new Map([
          ['team-1', { id: 'team-1', teamName: 'Team 1', gender: 'MALE' }],
          ['team-2', { id: 'team-2', teamName: 'Team 2', gender: 'MALE' }],
        ]),
      );

      const groupA = result.groups['A'];
      const team1 = groupA.find((s) => s.teamId === 'team-1')!;
      const team2 = groupA.find((s) => s.teamId === 'team-2')!;

      expect(team1.points).toBe(1);
      expect(team2.points).toBe(1);
    });
  });
});
