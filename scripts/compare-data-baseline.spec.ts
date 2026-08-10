/**
 * compare-data-baseline.spec.ts
 *
 * 比对基线比较器核心纯函数的单元测试。
 * 不依赖 Prisma / 文件系统 / 真实数据库，全量验证算法正确性。
 */
import {
  checkCount,
  checkPkSet,
  checkEntityHashes,
  checkPlayerTeamForeignKeys,
  checkMatchTeamForeignKeys,
  checkGoalForeignKeys,
  checkMatchEventForeignKeys,
  checkMatchLineupForeignKeys,
  checkV1LegacyForeignKeys,
} from './compare-logic';
import { computeCanonicalHash } from './canonical-sha256';

// ─── checkCount ─────────────────────────────────────────────────────────────

describe('checkCount', () => {
  it('当前数量等于基线时不报错', () => {
    const errors: string[] = [];
    checkCount(errors, 'Team', 121, 121);
    expect(errors).toHaveLength(0);
  });

  it('当前数量少于基线时报错', () => {
    const errors: string[] = [];
    checkCount(errors, 'Player', 100, 121);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Player');
    expect(errors[0]).toContain('100');
    expect(errors[0]).toContain('121');
  });

  it('当前数量多于基线时也报错（严格等长）', () => {
    const errors: string[] = [];
    checkCount(errors, 'Match', 200, 180);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Match');
    expect(errors[0]).toContain('200');
    expect(errors[0]).toContain('180');
  });

  it('expectedCount 为 undefined 时跳过校验', () => {
    const errors: string[] = [];
    checkCount(errors, 'Goal', 999, undefined);
    expect(errors).toHaveLength(0);
  });
});

// ─── checkPkSet ─────────────────────────────────────────────────────────────

describe('checkPkSet', () => {
  const items = [{ id: 'id-1' }, { id: 'id-2' }, { id: 'id-3' }];

  it('所有基线 ID 均存在时不报错', () => {
    const errors: string[] = [];
    checkPkSet(errors, 'Team', items, ['id-1', 'id-2', 'id-3']);
    expect(errors).toHaveLength(0);
  });

  it('基线中存在但当前缺失的 ID 应报错', () => {
    const errors: string[] = [];
    checkPkSet(errors, 'Team', items, ['id-1', 'id-4']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('id-4');
  });

  it('expectedIds 为 undefined 时跳过校验', () => {
    const errors: string[] = [];
    checkPkSet(errors, 'Team', items, undefined);
    expect(errors).toHaveLength(0);
  });

  it('expectedIds 为空数组时跳过校验', () => {
    const errors: string[] = [];
    checkPkSet(errors, 'Team', items, []);
    expect(errors).toHaveLength(0);
  });

  it('当前有多余 ID 不报错（仅校验基线 ID 是否存在）', () => {
    const errors: string[] = [];
    checkPkSet(errors, 'Team', [...items, { id: 'id-extra' }], ['id-1', 'id-2']);
    expect(errors).toHaveLength(0);
  });
});

// ─── checkEntityHashes ──────────────────────────────────────────────────────

describe('checkEntityHashes', () => {
  const row = {
    id: 'p-1',
    name: '张三',
    teamId: 'team-1',
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };
  const hash = computeCanonicalHash(row);

  it('记录未变更时哈希匹配，不报错', () => {
    const errors: string[] = [];
    checkEntityHashes(errors, 'Player', [row], { 'p-1': hash });
    expect(errors).toHaveLength(0);
  });

  it('记录被修改时哈希不匹配，报错', () => {
    const errors: string[] = [];
    const modified = { ...row, name: '李四' };
    checkEntityHashes(errors, 'Player', [modified], { 'p-1': hash });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-1');
    expect(errors[0]).toContain('SHA256');
  });

  it('基线中有哈希但当前数据库缺失该 ID 时报错', () => {
    const errors: string[] = [];
    checkEntityHashes(errors, 'Player', [], { 'p-missing': hash });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-missing');
    expect(errors[0]).toContain('不存在');
  });

  it('expectedHashes 为 undefined 时跳过校验', () => {
    const errors: string[] = [];
    checkEntityHashes(errors, 'Player', [row], undefined);
    expect(errors).toHaveLength(0);
  });

  it('快照中没有某条记录的哈希时跳过该条（当前有多余记录不报错）', () => {
    const errors: string[] = [];
    const extra = {
      id: 'p-2',
      name: '王五',
      teamId: 'team-2',
      createdAt: new Date('2024-02-01T00:00:00Z'),
    };
    checkEntityHashes(errors, 'Player', [row, extra], { 'p-1': hash });
    expect(errors).toHaveLength(0);
  });
});

// ─── checkPlayerTeamForeignKeys ─────────────────────────────────────────────

describe('checkPlayerTeamForeignKeys', () => {
  const playersMap = new Map([
    ['p-1', { id: 'p-1', teamId: 'team-A' }],
    ['p-2', { id: 'p-2', teamId: 'team-B' }],
  ]);

  it('外键匹配时不报错', () => {
    const errors: string[] = [];
    checkPlayerTeamForeignKeys(errors, playersMap, [
      { playerId: 'p-1', teamId: 'team-A' },
      { playerId: 'p-2', teamId: 'team-B' },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('外键不匹配时报错', () => {
    const errors: string[] = [];
    checkPlayerTeamForeignKeys(errors, playersMap, [{ playerId: 'p-1', teamId: 'team-WRONG' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-1');
    expect(errors[0]).toContain('teamId');
  });

  it('refs 为 undefined 时跳过校验', () => {
    const errors: string[] = [];
    checkPlayerTeamForeignKeys(errors, playersMap, undefined);
    expect(errors).toHaveLength(0);
  });
});

// ─── checkMatchTeamForeignKeys ──────────────────────────────────────────────

describe('checkMatchTeamForeignKeys', () => {
  const matchesMap = new Map([
    ['m-1', { id: 'm-1', homeTeamId: 'team-A', awayTeamId: 'team-B', seasonId: 's-1' }],
  ]);

  it('homeTeamId / awayTeamId / seasonId 全部匹配时不报错', () => {
    const errors: string[] = [];
    checkMatchTeamForeignKeys(errors, matchesMap, [
      { matchId: 'm-1', homeTeamId: 'team-A', awayTeamId: 'team-B', seasonId: 's-1' },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('homeTeamId 不匹配时报错', () => {
    const errors: string[] = [];
    checkMatchTeamForeignKeys(errors, matchesMap, [
      { matchId: 'm-1', homeTeamId: 'team-WRONG', awayTeamId: 'team-B', seasonId: 's-1' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('homeTeamId');
  });

  it('seasonId 不匹配时报错', () => {
    const errors: string[] = [];
    checkMatchTeamForeignKeys(errors, matchesMap, [
      { matchId: 'm-1', homeTeamId: 'team-A', awayTeamId: 'team-B', seasonId: 's-WRONG' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('seasonId');
  });
});

// ─── checkGoalForeignKeys ───────────────────────────────────────────────────

describe('checkGoalForeignKeys', () => {
  const goalsMap = new Map([['g-1', { id: 'g-1', matchId: 'm-1', playerId: 'p-1' }]]);

  it('外键匹配时不报错', () => {
    const errors: string[] = [];
    checkGoalForeignKeys(errors, goalsMap, [{ goalId: 'g-1', matchId: 'm-1', playerId: 'p-1' }]);
    expect(errors).toHaveLength(0);
  });

  it('matchId 不匹配时报错', () => {
    const errors: string[] = [];
    checkGoalForeignKeys(errors, goalsMap, [
      { goalId: 'g-1', matchId: 'm-WRONG', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('g-1');
    expect(errors[0]).toContain('matchId');
  });
});

// ─── checkMatchEventForeignKeys ─────────────────────────────────────────────

describe('checkMatchEventForeignKeys', () => {
  const eventsMap = new Map([['e-1', { id: 'e-1', matchId: 'm-1', playerId: 'p-1' }]]);

  it('外键匹配时不报错', () => {
    const errors: string[] = [];
    checkMatchEventForeignKeys(errors, eventsMap, [
      { eventId: 'e-1', matchId: 'm-1', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('playerId 不匹配时报错', () => {
    const errors: string[] = [];
    checkMatchEventForeignKeys(errors, eventsMap, [
      { eventId: 'e-1', matchId: 'm-1', playerId: 'p-WRONG' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('e-1');
    expect(errors[0]).toContain('playerId');
  });
});

// ─── checkMatchLineupForeignKeys ─────────────────────────────────────────────

describe('checkMatchLineupForeignKeys', () => {
  const lineupsMap = new Map([['l-1', { id: 'l-1', matchId: 'm-1', playerId: 'p-1' }]]);

  it('外键匹配时不报错', () => {
    const errors: string[] = [];
    checkMatchLineupForeignKeys(errors, lineupsMap, [
      { lineupId: 'l-1', matchId: 'm-1', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('matchId 不匹配时报错', () => {
    const errors: string[] = [];
    checkMatchLineupForeignKeys(errors, lineupsMap, [
      { lineupId: 'l-1', matchId: 'm-WRONG', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('l-1');
    expect(errors[0]).toContain('matchId');
  });

  it('refs 为空数组时不报错', () => {
    const errors: string[] = [];
    checkMatchLineupForeignKeys(errors, lineupsMap, []);
    expect(errors).toHaveLength(0);
  });

  it('外键快照引用的 lineupId 不在当前数据库中时静默跳过（不报错）', () => {
    // 当前行为：目标记录缺失时使用 continue，由主键校验负责发现缺失
    const errors: string[] = [];
    checkMatchLineupForeignKeys(errors, lineupsMap, [
      { lineupId: 'l-not-exist', matchId: 'm-1', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(0);
  });
});

// ─── checkPlayerTeamForeignKeys: 记录缺失时静默跳过 ────────────────────────────

describe('checkPlayerTeamForeignKeys — 目标记录缺失行为', () => {
  const playersMap = new Map([['p-1', { id: 'p-1', teamId: 'team-A' }]]);

  it('快照引用的 playerId 不在当前数据库中时静默跳过', () => {
    const errors: string[] = [];
    checkPlayerTeamForeignKeys(errors, playersMap, [{ playerId: 'p-not-exist', teamId: 'team-A' }]);
    // 目标记录缺失：由 checkPkSet 报告，此函数静默跳过
    expect(errors).toHaveLength(0);
  });
});

// ─── checkGoalForeignKeys: 记录缺失时静默跳过 ────────────────────────────────

describe('checkGoalForeignKeys — 目标记录缺失行为', () => {
  const goalsMap = new Map([['g-1', { id: 'g-1', matchId: 'm-1', playerId: 'p-1' }]]);

  it('快照引用的 goalId 不在当前数据库中时静默跳过', () => {
    const errors: string[] = [];
    checkGoalForeignKeys(errors, goalsMap, [
      { goalId: 'g-not-exist', matchId: 'm-1', playerId: 'p-1' },
    ]);
    expect(errors).toHaveLength(0);
  });
});

// ─── checkV1LegacyForeignKeys ────────────────────────────────────────────────

describe('checkV1LegacyForeignKeys', () => {
  const playersSet = new Set(['p-1', 'p-2', 'p-3', 'p-mvp']);

  it('所有 V1 引用的 Player ID 均存在时不报错', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchMvpPlayerIds: ['p-mvp'],
      matchEventPlayerIds: ['p-1', 'p-2'],
      matchEventAssistPlayerIds: ['p-3'],
    });
    expect(errors).toHaveLength(0);
  });

  it('matchMvpPlayerIds 中存在已删除球员时报错', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchMvpPlayerIds: ['p-deleted'],
      matchEventPlayerIds: [],
      matchEventAssistPlayerIds: [],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-deleted');
    expect(errors[0]).toContain('matchMvpPlayerIds');
  });

  it('matchEventPlayerIds 中存在已删除球员时报错', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchEventPlayerIds: ['p-1', 'p-gone'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-gone');
    expect(errors[0]).toContain('matchEventPlayerIds');
  });

  it('matchEventAssistPlayerIds 中存在已删除球员时报错', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchEventAssistPlayerIds: ['p-assist-gone'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('p-assist-gone');
    expect(errors[0]).toContain('matchEventAssistPlayerIds');
  });

  it('foreignKeys 为 undefined 时跳过校验', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, undefined);
    expect(errors).toHaveLength(0);
  });

  it('三组数组均为空时不报错', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchMvpPlayerIds: [],
      matchEventPlayerIds: [],
      matchEventAssistPlayerIds: [],
    });
    expect(errors).toHaveLength(0);
  });

  it('多个已删除球员时报错数量与缺失数量一致', () => {
    const errors: string[] = [];
    checkV1LegacyForeignKeys(errors, playersSet, {
      matchEventPlayerIds: ['p-gone-1', 'p-1', 'p-gone-2'],
    });
    expect(errors).toHaveLength(2);
  });
});
