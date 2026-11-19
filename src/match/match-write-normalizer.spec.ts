import { normalizeMatchPayload } from './match-write-normalizer';

describe('比赛比分规范化', () => {
  it.each(['1.5', 1.5, -1, '2abc', '1e2', Infinity, true])(
    '拒绝无效比分 %s，不静默截断',
    (score) => {
      expect(() => normalizeMatchPayload({ homeScore: score })).toThrow('主队得分必须是非负整数');
      expect(() => normalizeMatchPayload({ awayTeamScore: score })).toThrow(
        '客队得分必须是非负整数',
      );
    },
  );
  it('兼容整数、旧字段与未填写草稿', () => {
    expect(normalizeMatchPayload({ homeTeamScore: ' 3 ', awayScore: 0 })).toMatchObject({
      homeScore: 3,
      awayScore: 0,
    });
    expect(normalizeMatchPayload({})).toMatchObject({ homeScore: 0, awayScore: 0 });
  });
});
