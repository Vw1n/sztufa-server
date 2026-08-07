/**
 * compare-logic.ts
 * 基线比对核心纯函数，不依赖 Prisma / 文件系统，便于单元测试。
 */
import { computeCanonicalHash } from './canonical-sha256';

/** 严格等长校验：当前数量必须与基线完全一致 */
export function checkCount(
  errors: string[],
  name: string,
  currentLen: number,
  expectedCount: number | undefined,
): void {
  if (expectedCount === undefined) return;
  if (currentLen !== expectedCount) {
    errors.push(`${name} 记录数与基线不符: 当前 ${currentLen} 条，基线 ${expectedCount} 条`);
  }
}

/** 主键集合全量覆盖校验：基线中每一个 ID 都必须在当前数据中存在 */
export function checkPkSet(
  errors: string[],
  name: string,
  items: { id: string }[],
  expectedIds: string[] | undefined,
): void {
  if (!expectedIds || expectedIds.length === 0) return;
  const currentSet = new Set(items.map((i) => i.id));
  for (const id of expectedIds) {
    if (!currentSet.has(id)) {
      errors.push(`缺失基线 ${name} ID: ${id}`);
    }
  }
}

/** 确定性哈希比对：基线中有哈希的记录，当前值必须完全一致 */
export function checkEntityHashes(
  errors: string[],
  entityName: string,
  items: any[],
  expectedHashes: Record<string, string> | undefined,
): void {
  if (!expectedHashes) return;
  const itemMap = new Map(items.map((i) => [i.id, i]));
  for (const [id, expectedHash] of Object.entries(expectedHashes)) {
    const item = itemMap.get(id);
    if (!item) {
      errors.push(`${entityName} 记录 ID=${id} 在基线中有哈希但当前数据库中不存在`);
      continue;
    }
    const currentHash = computeCanonicalHash(item);
    if (currentHash !== expectedHash) {
      errors.push(`${entityName} 记录 ID=${id} 的 SHA256 哈希发生变更！`);
    }
  }
}

/** Player->Team 外键校验 */
export function checkPlayerTeamForeignKeys(
  errors: string[],
  playersMap: Map<string, any>,
  refs: { playerId: string; teamId: string }[] | undefined,
): void {
  for (const ref of refs ?? []) {
    const p = playersMap.get(ref.playerId);
    if (p && p.teamId !== ref.teamId) {
      errors.push(
        `Player (ID=${ref.playerId}) 的外键 teamId 不匹配: 当前 ${p.teamId} vs 基线 ${ref.teamId}`,
      );
    }
  }
}

/** Match->Team/Season 外键校验 */
export function checkMatchTeamForeignKeys(
  errors: string[],
  matchesMap: Map<string, any>,
  refs: { matchId: string; homeTeamId: string; awayTeamId: string; seasonId?: string }[] | undefined,
): void {
  for (const ref of refs ?? []) {
    const m = matchesMap.get(ref.matchId);
    if (!m) continue;
    if (m.homeTeamId !== ref.homeTeamId)
      errors.push(`Match (ID=${ref.matchId}) homeTeamId 外键不匹配`);
    if (m.awayTeamId !== ref.awayTeamId)
      errors.push(`Match (ID=${ref.matchId}) awayTeamId 外键不匹配`);
    if (ref.seasonId && m.seasonId !== ref.seasonId)
      errors.push(`Match (ID=${ref.matchId}) seasonId 外键不匹配`);
  }
}

/** Goal->Match/Player 外键校验 */
export function checkGoalForeignKeys(
  errors: string[],
  goalsMap: Map<string, any>,
  refs: { goalId: string; matchId: string; playerId: string }[] | undefined,
): void {
  for (const ref of refs ?? []) {
    const g = goalsMap.get(ref.goalId);
    if (!g) continue;
    if (g.matchId !== ref.matchId) errors.push(`Goal (ID=${ref.goalId}) matchId 外键不匹配`);
    if (g.playerId !== ref.playerId) errors.push(`Goal (ID=${ref.goalId}) playerId 外键不匹配`);
  }
}

/** MatchEvent->Match/Player 外键校验 */
export function checkMatchEventForeignKeys(
  errors: string[],
  eventsMap: Map<string, any>,
  refs: { eventId: string; matchId: string; playerId: string }[] | undefined,
): void {
  for (const ref of refs ?? []) {
    const e = eventsMap.get(ref.eventId);
    if (!e) continue;
    if (e.matchId !== ref.matchId)
      errors.push(`MatchEvent (ID=${ref.eventId}) matchId 外键不匹配`);
    if (e.playerId !== ref.playerId)
      errors.push(`MatchEvent (ID=${ref.eventId}) playerId 外键不匹配`);
  }
}

/** MatchLineup->Match/Player 外键校验 */
export function checkMatchLineupForeignKeys(
  errors: string[],
  lineupsMap: Map<string, any>,
  refs: { lineupId: string; matchId: string; playerId: string }[] | undefined,
): void {
  for (const ref of refs ?? []) {
    const l = lineupsMap.get(ref.lineupId);
    if (!l) continue;
    if (l.matchId !== ref.matchId)
      errors.push(`MatchLineup (ID=${ref.lineupId}) matchId 外键不匹配`);
    if (l.playerId !== ref.playerId)
      errors.push(`MatchLineup (ID=${ref.lineupId}) playerId 外键不匹配`);
  }
}

/**
 * V1 格式兼容外键校验
 *
 * V1 基线的 foreignKeys 格式为三组纯 Player ID 数组：
 *   - matchMvpPlayerIds：比赛 MVP 球员
 *   - matchEventPlayerIds：比赛事件主角球员
 *   - matchEventAssistPlayerIds：比赛事件助攻球员
 *
 * 语义：这些 Player ID 在 V1 快照时均存在且被引用，当前 Player 表中仍须全部找得到。
 * 若已被删除，说明历史引用球员的数据记录遭到了损毁。
 */
export function checkV1LegacyForeignKeys(
  errors: string[],
  playersSet: Set<string>,
  foreignKeys: {
    matchMvpPlayerIds?: string[];
    matchEventPlayerIds?: string[];
    matchEventAssistPlayerIds?: string[];
  } | undefined,
): void {
  if (!foreignKeys) return;

  const checkIds = (label: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      if (!playersSet.has(id)) {
        errors.push(`V1 外键 ${label} 引用的 Player ID=${id} 在当前数据库中不存在`);
      }
    }
  };

  checkIds('matchMvpPlayerIds', foreignKeys.matchMvpPlayerIds);
  checkIds('matchEventPlayerIds', foreignKeys.matchEventPlayerIds);
  checkIds('matchEventAssistPlayerIds', foreignKeys.matchEventAssistPlayerIds);
}
