import {
  findThirdPlaceMatch,
  getKnockoutWinnerTeamId,
  KnockoutMigrationMatch,
} from './knockout-migration';

const match = (
  overrides: Partial<KnockoutMigrationMatch>,
): KnockoutMigrationMatch => ({
  id: 'match',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeScore: 0,
  awayScore: 0,
  matchDate: new Date('2026-05-23T06:00:00.000Z'),
  status: 'finished',
  stage: 'KNOCKOUT',
  deletedAt: null,
  ...overrides,
});

describe('knockout migration', () => {
  it('can recover a legacy shootout winner from events', () => {
    expect(
      getKnockoutWinnerTeamId(
        match({
          events: [
            { eventType: 'penalty_shootout_goal', teamType: 'home' },
            { eventType: 'penalty_shootout_miss', teamType: 'away' },
          ],
        }),
      ),
    ).toBe('home');
  });

  it('finds the post-semifinal match between both losing teams', () => {
    const matches = [
      match({
        id: 'sf-1',
        homeTeamId: 'artificial-intelligence',
        awayTeamId: 'city',
        awayScore: 4,
        knockoutRound: 'SF',
        knockoutMatchIndex: 1,
      }),
      match({
        id: 'sf-2',
        homeTeamId: 'materials',
        awayTeamId: 'chips',
        awayScore: 1,
        knockoutRound: 'SF',
        knockoutMatchIndex: 2,
      }),
      match({
        id: 'old-group-match',
        homeTeamId: 'artificial-intelligence',
        awayTeamId: 'materials',
        matchDate: new Date('2026-04-11T06:00:00.000Z'),
        stage: 'GROUP',
        knockoutRound: null,
      }),
      match({
        id: 'third-place',
        homeTeamId: 'artificial-intelligence',
        awayTeamId: 'materials',
        matchDate: new Date('2026-05-30T06:00:00.000Z'),
        stage: 'LEAGUE',
        knockoutRound: null,
      }),
    ];

    expect(findThirdPlaceMatch(matches)?.id).toBe('third-place');
  });
});
