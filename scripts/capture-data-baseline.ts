import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { computeCanonicalHash } from './canonical-sha256';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
let outputFileArg = 'baseline-v2-before-v8.json';
const outIdx = args.indexOf('--output');
if (outIdx !== -1 && args[outIdx + 1]) {
  outputFileArg = args[outIdx + 1];
}

const OUTPUT_FILE = path.join(__dirname, outputFileArg);

async function captureBaseline() {
  if (fs.existsSync(OUTPUT_FILE)) {
    console.error(`[BASELINE ERROR] 基线文件已存在，拒绝覆盖: ${OUTPUT_FILE}`);
    process.exit(1);
  }

  console.log(`[BASELINE V2] 正在抓取只读脱敏 SHA256 基线快照 -> ${OUTPUT_FILE}...`);

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

  const mapHashes = (items: any[]) => {
    const recordMap: Record<string, string> = {};
    for (const item of items) {
      recordMap[item.id] = computeCanonicalHash(item);
    }
    return recordMap;
  };

  const baselineData = {
    capturedAt: new Date().toISOString(),
    version: 'V2-SHA256-FULL',
    counts: {
      teams: teams.length,
      players: players.length,
      matches: matches.length,
      goals: goals.length,
      matchEvents: matchEvents.length,
      matchLineups: matchLineups.length,
      seasonGroupTeams: seasonGroupTeams.length,
      seasonTeamProfiles: seasonTeamProfiles.length,
      seasonTeamPlayers: seasonTeamPlayers.length,
    },
    primaryKeySets: {
      teamIds: teams.map((t) => t.id).sort(),
      playerIds: players.map((p) => p.id).sort(),
      matchIds: matches.map((m) => m.id).sort(),
      goalIds: goals.map((g) => g.id).sort(),
      matchEventIds: matchEvents.map((e) => e.id).sort(),
      matchLineupIds: matchLineups.map((l) => l.id).sort(),
      seasonGroupTeamIds: seasonGroupTeams.map((s) => s.id).sort(),
      seasonTeamProfileIds: seasonTeamProfiles.map((sp) => sp.id).sort(),
      seasonTeamPlayerIds: seasonTeamPlayers.map((stp) => stp.id).sort(),
    },
    foreignKeys: {
      playerTeamIds: players.map((p) => ({ playerId: p.id, teamId: p.teamId })),
      matchTeamIds: matches.map((m) => ({
        matchId: m.id,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        seasonId: m.seasonId,
        mvpPlayerId: m.mvpPlayerId,
      })),
      goalRefs: goals.map((g) => ({
        goalId: g.id,
        matchId: g.matchId,
        teamType: g.teamType,
        playerId: g.playerId,
      })),
      matchEventRefs: matchEvents.map((e) => ({
        eventId: e.id,
        matchId: e.matchId,
        teamType: e.teamType,
        playerId: e.playerId,
        assistPlayerId: e.assistPlayerId,
        subPlayerId: e.subPlayerId,
      })),
      matchLineupRefs: matchLineups.map((l) => ({
        lineupId: l.id,
        matchId: l.matchId,
        teamType: l.teamType,
        playerId: l.playerId,
      })),
    },
    hashes: {
      teams: mapHashes(teams),
      players: mapHashes(players),
      matches: mapHashes(matches),
      goals: mapHashes(goals),
      matchEvents: mapHashes(matchEvents),
      matchLineups: mapHashes(matchLineups),
      seasonGroupTeams: mapHashes(seasonGroupTeams),
      seasonTeamProfiles: mapHashes(seasonTeamProfiles),
      seasonTeamPlayers: mapHashes(seasonTeamPlayers),
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(baselineData, null, 2), 'utf-8');
  console.log(`[BASELINE SUCCESS] 基线快照已成功导出至: ${OUTPUT_FILE}`);
  console.log(
    `- 球队: ${teams.length}, 球员: ${players.length}, 比赛: ${matches.length}, 进球: ${goals.length}, 事件: ${matchEvents.length}, 阵容: ${matchLineups.length}`,
  );

  await prisma.$disconnect();
}

captureBaseline().catch((err) => {
  console.error('[BASELINE FAILED]', err);
  prisma.$disconnect();
  process.exit(1);
});
