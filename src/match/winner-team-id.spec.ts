import {
  getCanonicalWinnerTeamId,
  isHistoricalSeasonTeamIdMatch,
  MatchLike,
} from './winner-team-id';

describe('winner-team-id 统一胜者解析测试', () => {
  describe('isHistoricalSeasonTeamIdMatch', () => {
    it('全等匹配返回 true', () => {
      expect(isHistoricalSeasonTeamIdMatch('team-a', 'team-a')).toBe(true);
      expect(isHistoricalSeasonTeamIdMatch('team-a_season_2025', 'team-a_season_2025')).toBe(true);
    });

    it('基础 ID ↔ 赛季 ID 双向匹配返回 true', () => {
      expect(isHistoricalSeasonTeamIdMatch('team-a', 'team-a_season_2025')).toBe(true);
      expect(isHistoricalSeasonTeamIdMatch('team-a_season_2025', 'team-a')).toBe(true);
    });

    it('双赛季 ID 不等时返回 false（防止跨赛季互认）', () => {
      expect(isHistoricalSeasonTeamIdMatch('team-a_season_2025', 'team-a_season_2026')).toBe(false);
    });

    it('不同基础 ID 返回 false', () => {
      expect(isHistoricalSeasonTeamIdMatch('team-a', 'team-b')).toBe(false);
      expect(isHistoricalSeasonTeamIdMatch('team-a_season_2025', 'team-b')).toBe(false);
    });

    it('空值返回 false', () => {
      expect(isHistoricalSeasonTeamIdMatch(null, 'team-a')).toBe(false);
      expect(isHistoricalSeasonTeamIdMatch('team-a', '')).toBe(false);
      expect(isHistoricalSeasonTeamIdMatch(undefined, undefined)).toBe(false);
    });
  });

  describe('getCanonicalWinnerTeamId', () => {
    const baseMatch: MatchLike = {
      homeTeamId: 'home_season_2025',
      awayTeamId: 'away_season_2025',
      homeScore: 0,
      awayScore: 0,
      homePenaltyScore: null,
      awayPenaltyScore: null,
      winnerTeamId: null,
      events: [],
    };

    it('优先级1：常规比分绝杀胜者高于冲突的旧 winnerTeamId', () => {
      const match: MatchLike = {
        ...baseMatch,
        homeScore: 2,
        awayScore: 1,
        winnerTeamId: 'away', // 错误的旧胜者
      };
      expect(getCanonicalWinnerTeamId(match)).toBe('home_season_2025');
    });

    it('优先级2：常规平局且存在结构化点球比分时，点球胜者决胜', () => {
      const match: MatchLike = {
        ...baseMatch,
        homeScore: 1,
        awayScore: 1,
        homePenaltyScore: 3,
        awayPenaltyScore: 4,
        winnerTeamId: 'home',
      };
      expect(getCanonicalWinnerTeamId(match)).toBe('away_season_2025');
    });

    it('优先级3：常规平局且无结构化点球比分时，由点球事件决胜', () => {
      const match: MatchLike = {
        ...baseMatch,
        events: [
          { eventType: 'penalty_shootout_goal', teamType: 'home' },
          { eventType: 'penalty_shootout_miss', teamType: 'away' },
        ],
      };
      expect(getCanonicalWinnerTeamId(match)).toBe('home_season_2025');
    });

    it('优先级4：1~3无比分/事件时，通过历史 ID 映射匹配 homeTeamId 或 awayTeamId', () => {
      const match: MatchLike = {
        ...baseMatch,
        winnerTeamId: 'home', // 基础 ID
      };
      expect(getCanonicalWinnerTeamId(match)).toBe('home_season_2025');
    });

    it('无队伍 ID 时返回 null', () => {
      expect(getCanonicalWinnerTeamId({ homeTeamId: null, awayTeamId: 'away' })).toBeNull();
    });

    it('winnerTeamId 归一化后矛盾或不匹配任何队伍时返回 null', () => {
      const match: MatchLike = {
        ...baseMatch,
        winnerTeamId: 'unknown-team',
      };
      expect(getCanonicalWinnerTeamId(match)).toBeNull();
    });
  });
});
