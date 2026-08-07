import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
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

const prisma = new PrismaClient();

const args = process.argv.slice(2);
let inputFileArg = 'pre-migration-baseline.json';
const inIdx = args.indexOf('--input');
if (inIdx !== -1 && args[inIdx + 1]) {
  inputFileArg = args[inIdx + 1];
}

const BASELINE_FILE = path.join(__dirname, inputFileArg);

async function compareBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`[BASELINE ERROR] 未找到指定的基线快照文件: ${BASELINE_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(BASELINE_FILE, 'utf-8');
  const snapshot = JSON.parse(raw);

  console.log(`[BASELINE] 正在比对当前数据库状态与基线快照 (${inputFileArg}, 捕获于 ${snapshot.capturedAt})...`);

  const errors: string[] = [];

  const [
    teams,
    players,
    matches,
    goals,
    matchEvents,
    matchLineups,
    seasonGroupTeams,
    seasonTeamProfiles,
    seasonTeamPlayers,
  ] = await Promise.all([
    prisma.team.findMany({ orderBy: { id: 'asc' } }),
    prisma.player.findMany({ orderBy: { id: 'asc' } }),
    prisma.match.findMany({ orderBy: { id: 'asc' } }),
    prisma.goal.findMany({ orderBy: { id: 'asc' } }),
    prisma.matchEvent.findMany({ orderBy: { id: 'asc' } }),
    prisma.matchLineup.findMany({ orderBy: { id: 'asc' } }),
    prisma.seasonGroupTeam.findMany({ orderBy: { id: 'asc' } }),
    prisma.seasonTeamProfile.findMany({ orderBy: { id: 'asc' } }),
    prisma.seasonTeamPlayer.findMany({ orderBy: { id: 'asc' } }),
  ]);

  // 1. 严格等长校验（不允许增加也不允许减少）
  checkCount(errors, 'Team', teams.length, snapshot.counts?.teams);
  checkCount(errors, 'Player', players.length, snapshot.counts?.players);
  checkCount(errors, 'Match', matches.length, snapshot.counts?.matches);
  checkCount(errors, 'Goal', goals.length, snapshot.counts?.goals);
  checkCount(errors, 'MatchEvent', matchEvents.length, snapshot.counts?.matchEvents);
  checkCount(errors, 'MatchLineup', matchLineups.length, snapshot.counts?.matchLineups);
  checkCount(errors, 'SeasonGroupTeam', seasonGroupTeams.length, snapshot.counts?.seasonGroupTeams);
  checkCount(errors, 'SeasonTeamProfile', seasonTeamProfiles.length, snapshot.counts?.seasonTeamProfiles);
  checkCount(errors, 'SeasonTeamPlayer', seasonTeamPlayers.length, snapshot.counts?.seasonTeamPlayers);

  // 2. 主键集合全量覆盖
  const pkSets = snapshot.primaryKeySets || {};
  checkPkSet(errors, 'Team', teams, pkSets.teamIds);
  checkPkSet(errors, 'Player', players, pkSets.playerIds);
  checkPkSet(errors, 'Match', matches, pkSets.matchIds);
  checkPkSet(errors, 'Goal', goals, pkSets.goalIds);
  checkPkSet(errors, 'MatchEvent', matchEvents, pkSets.matchEventIds);
  checkPkSet(errors, 'MatchLineup', matchLineups, pkSets.matchLineupIds);
  checkPkSet(errors, 'SeasonGroupTeam', seasonGroupTeams, pkSets.seasonGroupTeamIds);
  checkPkSet(errors, 'SeasonTeamProfile', seasonTeamProfiles, pkSets.seasonTeamProfileIds);
  checkPkSet(errors, 'SeasonTeamPlayer', seasonTeamPlayers, pkSets.seasonTeamPlayerIds);

  // 3. 外键映射比对（自动检测 V1 / V2 格式）
  if (snapshot.foreignKeys) {
    const isV1Format = 'matchMvpPlayerIds' in snapshot.foreignKeys ||
      'matchEventPlayerIds' in snapshot.foreignKeys ||
      'matchEventAssistPlayerIds' in snapshot.foreignKeys;

    if (isV1Format) {
      // V1 格式：三组纯 Player ID 数组，验证这些球员 ID 在当前数据库中仍然存在
      console.log('[BASELINE] 检测到 V1 外键格式，使用兼容校验（matchMvpPlayerIds / matchEventPlayerIds / matchEventAssistPlayerIds）...');
      const playersSet = new Set(players.map((p) => p.id));
      checkV1LegacyForeignKeys(errors, playersSet, snapshot.foreignKeys);
    } else {
      // V2 格式：对象数组，包含完整的双端 ID 映射
      const playersMap = new Map(players.map((p) => [p.id, p]));
      const matchesMap = new Map(matches.map((m) => [m.id, m]));
      const goalsMap = new Map(goals.map((g) => [g.id, g]));
      const eventsMap = new Map(matchEvents.map((e) => [e.id, e]));
      const lineupsMap = new Map(matchLineups.map((l) => [l.id, l]));

      checkPlayerTeamForeignKeys(errors, playersMap, snapshot.foreignKeys.playerTeamIds);
      checkMatchTeamForeignKeys(errors, matchesMap, snapshot.foreignKeys.matchTeamIds);
      checkGoalForeignKeys(errors, goalsMap, snapshot.foreignKeys.goalRefs);
      checkMatchEventForeignKeys(errors, eventsMap, snapshot.foreignKeys.matchEventRefs);
      checkMatchLineupForeignKeys(errors, lineupsMap, snapshot.foreignKeys.matchLineupRefs);
    }
  }


  // 4. 确定性哈希比对（仅当快照包含 hashes 字段时生效）
  if (snapshot.hashes) {
    checkEntityHashes(errors, 'Team', teams, snapshot.hashes.teams);
    checkEntityHashes(errors, 'Player', players, snapshot.hashes.players);
    checkEntityHashes(errors, 'Match', matches, snapshot.hashes.matches);
    checkEntityHashes(errors, 'Goal', goals, snapshot.hashes.goals);
    checkEntityHashes(errors, 'MatchEvent', matchEvents, snapshot.hashes.matchEvents);
    checkEntityHashes(errors, 'MatchLineup', matchLineups, snapshot.hashes.matchLineups);
    checkEntityHashes(errors, 'SeasonGroupTeam', seasonGroupTeams, snapshot.hashes.seasonGroupTeams);
    checkEntityHashes(errors, 'SeasonTeamProfile', seasonTeamProfiles, snapshot.hashes.seasonTeamProfiles);
    checkEntityHashes(errors, 'SeasonTeamPlayer', seasonTeamPlayers, snapshot.hashes.seasonTeamPlayers);
  } else {
    console.warn('[BASELINE WARNING] 当前快照不含 hashes 字段，跳过逐行 SHA256 哈希比对。建议使用 V2 基线进行完整哈希验证。');
  }

  if (errors.length > 0) {
    console.error(`[BASELINE VERIFICATION FAILED] 发现 ${errors.length} 项差异:`);
    errors.slice(0, 20).forEach((err) => console.error(` - ${err}`));
    if (errors.length > 20) console.error(` - ... 等共 ${errors.length} 项错误`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`[BASELINE VERIFICATION PASSED] ${inputFileArg} 比对验证通过！已有历史主键、外键${snapshot.hashes ? '与 SHA256 记录哈希' : ''}无任何损毁与变更！`);
  await prisma.$disconnect();
}

compareBaseline().catch((err) => {
  console.error('[BASELINE FAILED]', err);
  prisma.$disconnect();
  process.exit(1);
});
