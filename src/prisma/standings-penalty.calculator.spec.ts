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
  });
});
