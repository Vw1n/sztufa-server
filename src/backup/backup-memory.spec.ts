import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('真实对象备份有界内存压测基准 (60MB vs 120MB)', () => {
  const runnerScriptPath = path.join(os.tmpdir(), `backup-memory-runner-${Date.now()}.js`);

  beforeAll(() => {
    // 写入独立 Node.js 子进程运行脚本
    const runnerCode = `
const { createV3BackupStream, parseAndValidateBackupStream } = require('${path.join(__dirname, 'backup-serializer').replace(/\\/g, '\\\\')}');
const { validateBackupStreamIntegrity, validateForeignKeysFromStaging } = require('${path.join(__dirname, 'backup-validator').replace(/\\/g, '\\\\')}');
const { MANDATORY_BACKUP_TABLES } = require('${path.join(__dirname, 'backup-table-registry').replace(/\\/g, '\\\\')}');

async function runBenchmark(targetMb) {
  if (global.gc) global.gc();

  const baselineMem = process.memoryUsage();
  let peakHeapUsed = baselineMem.heapUsed;
  let peakExternal = baselineMem.external;
  let peakArrayBuffers = baselineMem.arrayBuffers;
  let peakRss = baselineMem.rss;
  let maxBatchSeen = 0;

  function sampleMem() {
    const mem = process.memoryUsage();
    if (mem.heapUsed > peakHeapUsed) peakHeapUsed = mem.heapUsed;
    if (mem.external > peakExternal) peakExternal = mem.external;
    if (mem.arrayBuffers > peakArrayBuffers) peakArrayBuffers = mem.arrayBuffers;
    if (mem.rss > peakRss) peakRss = mem.rss;
  }

  const numRecordsPerTable = Math.ceil((targetMb * 1024 * 1024) / (17 * 500));

  const startTime = Date.now();
  sampleMem();

  const pageProvider = (tableName) => {
    return (async function* () {
      const recordsPerPage = 500;
      for (let i = 0; i < numRecordsPerTable; i += recordsPerPage) {
        const batch = [];
        const end = Math.min(i + recordsPerPage, numRecordsPerTable);
        for (let j = i; j < end; j++) {
          const recId = tableName + '_' + j;
          const isFirst = (j === 0);

          let row = {
            id: recId,
            name: '测试物理对象 ' + tableName + ' 行 ' + j + ' ⚽ 🔥',
            detail: 'X'.repeat(400),
            nestedJson: { index: j, text: 'Nested complex object', flags: [true, false, 123.45] },
            createdAt: '2026-06-01T12:00:00.000Z',
          };

          if (tableName === 'Season') {
            row.name = '赛季 ' + j;
            row.status = 'active';
            row.type = 'LEAGUE';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'Team') {
            row.teamName = '球队 ' + j;
            row.homeJerseyColor = '红';
            row.awayJerseyColor = '蓝';
            row.gender = 'MALE';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'Player') {
            row.studentId = 'STU_' + j;
            row.jerseyNumber = String(j % 99);
            row.teamId = 'Team_0';
            row.suspendedAtMatchId = null;
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'Match') {
            row.homeTeamId = 'Team_0';
            row.awayTeamId = 'Team_0';
            row.seasonId = 'Season_0';
            row.mvpPlayerId = 'Player_0';
            row.matchDate = '2026-06-01T12:00:00.000Z';
            row.location = 'Stadium';
            row.stage = 'LEAGUE';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'Goal') {
            row.matchId = 'Match_' + (j % numRecordsPerTable);
            row.playerId = 'Player_0';
            row.playerName = 'Goal Scorer';
            row.jerseyNumber = '10';
            row.goalTime = '45';
            row.teamType = 'home';
          } else if (tableName === 'MatchEvent') {
            row.matchId = 'Match_' + (j % numRecordsPerTable);
            row.eventTime = '30';
            row.eventType = 'foul';
            row.playerId = 'Player_0';
            row.subPlayerId = 'Player_0';
            row.assistPlayerId = 'Player_0';
            row.description = 'Foul';
            row.teamType = 'home';
          } else if (tableName === 'MatchLineup') {
            row.matchId = 'Match_' + (j % numRecordsPerTable);
            row.playerId = isFirst ? 'Player_0' : 'Player_' + j;
            row.teamType = 'home';
            row.lineupType = 'starting';
          } else if (tableName === 'Prediction') {
            row.userId = 'User_' + (j % numRecordsPerTable);
            row.matchId = 'Match_' + (j % numRecordsPerTable);
            row.choice = 'HOME_WIN';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'User') {
            row.username = 'user_' + j;
            row.studentId = 'U_STU_' + j;
            row.password = 'hash';
            row.role = 'user';
            row.teamId = 'Team_0';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'SeasonTeamProfile') {
            row.seasonId = 'Season_0';
            row.teamId = isFirst ? 'Team_0' : 'Team_' + j;
            row.teamName = 'Team ' + j;
            row.homeJerseyColor = '红';
            row.awayJerseyColor = '蓝';
            row.gender = 'MALE';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'SeasonTeamPlayer') {
            row.seasonId = 'Season_0';
            row.teamId = 'Team_0';
            row.playerId = isFirst ? 'Player_0' : 'Player_' + j;
            row.playerName = 'Name';
            row.jerseyNumber = '10';
          } else if (tableName === 'SeasonGroupTeam') {
            row.seasonId = 'Season_0';
            row.teamId = isFirst ? 'Team_0' : 'Team_' + j;
            row.groupName = 'A';
          } else if (tableName === 'SeasonDeletionApproval') {
            row.seasonId = 'Season_0';
            row.approverId = isFirst ? 'User_0' : 'User_' + j;
          } else if (tableName === 'HistoryImportBatch') {
            row.digest = 'digest_' + j;
            row.username = 'admin';
            row.summary = {};
            row.undoPayload = {};
          } else if (tableName === 'AuditLog') {
            row.username = 'admin';
            row.action = 'ACTION';
            row.details = 'details';
          } else if (tableName === 'News') {
            row.title = 'Title ' + j;
            row.category = 'cat';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          } else if (tableName === 'PdfImportBatch') {
            row.fileHash = 'hash_' + j;
            row.username = 'admin';
            row.expiresAt = '2026-06-01T12:00:00.000Z';
            row.updatedAt = '2026-06-01T12:00:00.000Z';
          }

          batch.push(row);
        }
        if (batch.length > maxBatchSeen) maxBatchSeen = batch.length;
        yield batch;
        sampleMem();
      }
    })();
  };

  const { stream, checksumPromise } = createV3BackupStream(pageProvider);
  sampleMem();

  const parseResult = await parseAndValidateBackupStream(stream, 'benchmark.json.gz');
  sampleMem();

  validateBackupStreamIntegrity(parseResult);
  sampleMem();

  await validateForeignKeysFromStaging(parseResult);
  sampleMem();

  const checksum = await checksumPromise;
  sampleMem();

  const durationMs = Date.now() - startTime;
  const finalHeapDiffMb = (peakHeapUsed - baselineMem.heapUsed) / (1024 * 1024);

  parseResult.cleanup();
  if (global.gc) global.gc();

  console.log(JSON.stringify({
    targetMb,
    durationMs,
    baselineHeapMb: (baselineMem.heapUsed / (1024 * 1024)).toFixed(2),
    peakHeapMb: (peakHeapUsed / (1024 * 1024)).toFixed(2),
    heapDiffMb: finalHeapDiffMb.toFixed(2),
    peakExternalMb: (peakExternal / (1024 * 1024)).toFixed(2),
    peakArrayBuffersMb: (peakArrayBuffers / (1024 * 1024)).toFixed(2),
    peakRssMb: (peakRss / (1024 * 1024)).toFixed(2),
    maxBatchSeen,
    checksum,
  }));
}

const targetMb = parseFloat(process.argv[2] || '60');
runBenchmark(targetMb).catch(err => {
  console.error(err);
  process.exit(1);
});
    `;

    fs.writeFileSync(runnerScriptPath, runnerCode, 'utf8');
  });

  afterAll(() => {
    try {
      if (fs.existsSync(runnerScriptPath)) {
        fs.unlinkSync(runnerScriptPath);
      }
    } catch {}
  });

  const runSubprocess = (targetMb: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      child_process.exec(
        `node -r ts-node/register --expose-gc "${runnerScriptPath}" ${targetMb}`,
        {
          cwd: path.join(__dirname, '../..'),
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(`子进程压测失败: ${error.message}\n${stderr}`));
          }
          try {
            const lines = stdout.trim().split('\n');
            const jsonLine = lines[lines.length - 1];
            resolve(JSON.parse(jsonLine));
          } catch {
            reject(new Error(`解析压测输出失败: ${stdout}`));
          }
        },
      );
    });
  };

  it('60 MB 与 120 MB 真实数据量下对比压测，严格验证堆增量 <= 96MB 及非线性 O(1) 增长', async () => {
    const res60 = await runSubprocess(60);
    const diff60 = parseFloat(res60.heapDiffMb);

    console.log(
      `[60MB 压测] Baseline: ${res60.baselineHeapMb} MB, 堆增量: ${diff60} MB, RSS: ${res60.peakRssMb} MB, External: ${res60.peakExternalMb} MB, ArrayBuffers: ${res60.peakArrayBuffersMb} MB, 最大批次: ${res60.maxBatchSeen}, 耗时: ${res60.durationMs} ms`,
    );
    expect(diff60).toBeLessThanOrEqual(96);
    expect(res60.maxBatchSeen).toBeLessThanOrEqual(500);

    const res120 = await runSubprocess(120);
    const diff120 = parseFloat(res120.heapDiffMb);

    console.log(
      `[120MB 压测] Baseline: ${res120.baselineHeapMb} MB, 堆增量: ${diff120} MB, RSS: ${res120.peakRssMb} MB, External: ${res120.peakExternalMb} MB, ArrayBuffers: ${res120.peakArrayBuffersMb} MB, 最大批次: ${res120.maxBatchSeen}, 耗时: ${res120.durationMs} ms`,
    );
    expect(diff120).toBeLessThanOrEqual(96);
    expect(res120.maxBatchSeen).toBeLessThanOrEqual(500);

    // 比较断言：验证 60MB -> 120MB 数据量翻倍时，堆增量差值不超过 20 MB，证明 O(1) 非线性增长！
    const deltaDiff = Math.abs(diff120 - diff60);
    console.log(`[增量对比] 120MB 与 60MB 堆增量差值: ${deltaDiff.toFixed(2)} MB`);
    // 60MB + 120MB 两个子进程串行实测约 1012 秒（60MB≈328s，120MB≈684s），
    // 900s 的 jest 超时会提前掐断导致误报失败，故提升至 20 分钟。
    expect(deltaDiff).toBeLessThan(20);
  }, 1200000);
});
