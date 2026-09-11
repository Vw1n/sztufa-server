import { PrismaClient } from '@prisma/client';
import { BackupService } from '../src/backup/backup.service';
import { BackupRetentionService } from '../src/backup/backup-retention.service';
import { BackupScopeService } from '../src/backup/backup-scope.service';
import { BackupObjectStoreService } from '../src/backup/backup-object-store.service';
import { BackupVerificationService } from '../src/backup/backup-verification.service';
import { BackupExportService } from '../src/backup/backup-export.service';
import { BackupRestoreService } from '../src/backup/backup-restore.service';
import { BackupUploadService } from '../src/backup/backup-upload.service';
import { BackupMaintenanceService } from '../src/backup/backup-maintenance.service';
import { BackupPlanService } from '../src/backup/backup-plan.service';
import { BackupModuleRestoreService } from '../src/backup/backup-module-restore.service';
import { BackupFingerprintService } from '../src/backup/backup-fingerprint.service';
import { PrismaService } from '../src/prisma/prisma.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Client as PgClient } from 'pg';

const ADVISORY_LOCK_ID = 77887788;
const REPORTS_DIR = path.join(__dirname, 'drill-reports');

// 逆序级联外键依赖清理表列表
const CLEANUP_TABLE_ORDER: Array<{ table: string; model: keyof PrismaClient }> = [
  { table: 'Goal', model: 'goal' },
  { table: 'MatchEvent', model: 'matchEvent' },
  { table: 'MatchLineup', model: 'matchLineup' },
  { table: 'Prediction', model: 'prediction' },
  { table: 'Match', model: 'match' },
  { table: 'SeasonTeamProfile', model: 'seasonTeamProfile' },
  { table: 'SeasonGroupTeam', model: 'seasonGroupTeam' },
  { table: 'SeasonTeamPlayer', model: 'seasonTeamPlayer' },
  { table: 'SeasonDeletionApproval', model: 'seasonDeletionApproval' },
  { table: 'Season', model: 'season' },
  { table: 'Player', model: 'player' },
  { table: 'Team', model: 'team' },
  { table: 'News', model: 'news' },
  { table: 'User', model: 'user' },
  { table: 'MemberAccount', model: 'memberAccount' },
  { table: 'AuditLog', model: 'auditLog' },
  { table: 'HistoryImportBatch', model: 'historyImportBatch' },
];

async function main() {
  const args = process.argv.slice(2);
  const allowSkip = args.includes('--allow-skip');
  const cleanupRunIdx = args.indexOf('--cleanup-run');
  const targetCleanupRunId = cleanupRunIdx !== -1 ? args[cleanupRunIdx + 1] : null;

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  // 1. 安全环境前置校验
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl) {
    if (allowSkip) {
      console.log(
        '[DRILL SKIP] 未配置 TEST_DATABASE_URL 环境变量，且指定了 --allow-skip 参数，安全跳过真实恢复演练。',
      );
      process.exit(0);
    }
    console.error(
      '[DRILL FATAL] 未配置 TEST_DATABASE_URL！恢复演练要求连接隔离测试库（名称必须以 _test 结尾）。',
    );
    process.exit(1);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(testDbUrl);
  } catch {
    console.error(`[DRILL FATAL] TEST_DATABASE_URL 格式非法: ${testDbUrl}`);
    process.exit(1);
  }

  const dbName = parsedUrl.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    console.error(
      `[DRILL FATAL] 测试数据库名称必须以 _test 结尾，当前为: ${dbName}，拒绝在非测试库执行恢复演练！`,
    );
    process.exit(1);
  }

  const allowedHosts = (process.env.ALLOWED_TEST_DB_HOSTS || 'localhost,127.0.0.1,postgres,db')
    .split(',')
    .map((h) => h.trim());
  if (!allowedHosts.includes(parsedUrl.hostname)) {
    console.error(
      `[DRILL FATAL] 测试数据库 Host (${parsedUrl.hostname}) 不在白名单 (${allowedHosts.join(', ')}) 中！`,
    );
    process.exit(1);
  }

  const testPrisma = new PrismaClient({
    datasources: {
      db: { url: testDbUrl },
    },
  });
  await testPrisma.$connect();

  // 2. 显式清理指定历史运行 (--cleanup-run <drillRunId>)
  if (targetCleanupRunId) {
    console.log(`[DRILL CLEANUP] 正在针对演练运行 ${targetCleanupRunId} 执行定向清理...`);
    const manifestPath = path.join(REPORTS_DIR, `manifest-${targetCleanupRunId}.json`);
    if (!fs.existsSync(manifestPath)) {
      console.error(`[DRILL CLEANUP ERROR] 未找到指定演练运行的 manifest 文件: ${manifestPath}`);
      await testPrisma.$disconnect();
      process.exit(1);
    }

    let cleanupLockClient: PgClient | null = null;
    let cleanupLockAcquired = false;
    try {
      cleanupLockClient = new PgClient({ connectionString: testDbUrl });
      await cleanupLockClient.connect();
      const lockRes = await cleanupLockClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ADVISORY_LOCK_ID],
      );
      if (!lockRes.rows[0]?.locked) {
        console.error(
          `[DRILL CLEANUP ERROR] 无法获取排他锁 (${ADVISORY_LOCK_ID})，当前有演练或其他清理进程正在运行！`,
        );
        await cleanupLockClient.end().catch(() => {});
        await testPrisma.$disconnect();
        process.exit(1);
      }
      cleanupLockAcquired = true;
    } catch (lockErr) {
      console.error('[DRILL CLEANUP ERROR] 连接数据库获取排他锁失败:', lockErr);
      if (cleanupLockClient) await cleanupLockClient.end().catch(() => {});
      await testPrisma.$disconnect();
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const { createdRecordIds = {}, createdR2Keys = [] } = manifest;

    const remainingRecordIds: Record<string, string[]> = {};
    let dbCleanupFailed = false;

    for (const { table, model } of CLEANUP_TABLE_ORDER) {
      const ids = createdRecordIds[table] as string[] | undefined;
      if (ids && ids.length > 0) {
        try {
          if (typeof (testPrisma[model] as any)?.deleteMany === 'function') {
            await (testPrisma[model] as any).deleteMany({
              where: { id: { in: ids } },
            });
            // 校验确认数据库中是否还有残留 ID
            const remaining = await (testPrisma[model] as any).findMany({
              where: { id: { in: ids } },
              select: { id: true },
            });
            if (remaining.length > 0) {
              const remIds = remaining.map((r: any) => r.id);
              remainingRecordIds[table] = remIds;
              dbCleanupFailed = true;
              console.warn(
                `[DRILL CLEANUP WARN] ${table}: 尚有 ${remaining.length} 笔记录未能清理完成: ${remIds.join(', ')}`,
              );
            } else {
              console.log(`[DRILL CLEANUP] ${table}: 全部 ${ids.length} 笔记录已确认删除`);
            }
          }
        } catch (delErr) {
          dbCleanupFailed = true;
          remainingRecordIds[table] = ids;
          console.error(`[DRILL CLEANUP ERROR] 清理 ${table} 记录异常:`, delErr);
        }
      }
    }

    const objectStore = new BackupObjectStoreService();
    const remainingR2Keys: string[] = [];
    let r2CleanupFailed = false;

    for (const key of createdR2Keys as string[]) {
      try {
        await objectStore.deleteObject(key);
        console.log(`[DRILL CLEANUP] R2 对象已删除: ${key}`);
      } catch (err) {
        r2CleanupFailed = true;
        remainingR2Keys.push(key);
        console.error(`[DRILL CLEANUP ERROR] 删除 R2 对象失败: ${key}`, err);
      }
    }

    // 更新 manifest 数据结构
    manifest.createdRecordIds = remainingRecordIds;
    manifest.createdR2Keys = remainingR2Keys;

    const hasRemaining =
      dbCleanupFailed ||
      r2CleanupFailed ||
      remainingR2Keys.length > 0 ||
      Object.keys(remainingRecordIds).length > 0;

    if (hasRemaining) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      console.error(
        `\n❌ [DRILL CLEANUP FAILED] 定向清理存在未完成项，已保留更新后的 manifest 文件以供重试: ${manifestPath}`,
      );
      if (cleanupLockClient && cleanupLockAcquired) {
        await cleanupLockClient
          .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID])
          .catch(() => {});
        await cleanupLockClient.end().catch(() => {});
      }
      await testPrisma.$disconnect();
      process.exit(1);
    }

    // 全部确认删除后方可删除 manifest
    fs.unlinkSync(manifestPath);
    console.log(`\n✅ [DRILL CLEANUP SUCCESS] 全部演练资源已确认物理销毁，已移除 ${manifestPath}`);

    if (cleanupLockClient && cleanupLockAcquired) {
      await cleanupLockClient
        .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID])
        .catch(() => {});
      await cleanupLockClient.end().catch(() => {});
    }
    await testPrisma.$disconnect();
    process.exit(0);
  }

  // 3. 获取 Advisory Lock 排他锁（使用固定的专用 pg Client 单连接持有，严格防止连接池调度导致锁丢失）
  let lockClient: PgClient | null = null;
  let lockAcquired = false;

  try {
    lockClient = new PgClient({ connectionString: testDbUrl });
    await lockClient.connect();
    const lockRes = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ADVISORY_LOCK_ID],
    );
    if (!lockRes.rows[0]?.locked) {
      console.error(
        `[DRILL FATAL] 无法获取演练排他锁 (${ADVISORY_LOCK_ID})，已有其他演练进程正在运行！`,
      );
      await lockClient.end().catch(() => {});
      await testPrisma.$disconnect();
      process.exit(1);
    }
    lockAcquired = true;
    console.log(`🔒 [DRILL LOCK] 已通过专用数据库连接成功持有排他锁 (${ADVISORY_LOCK_ID})`);
  } catch (lockConnErr) {
    console.error(`[DRILL FATAL] 连接测试数据库以获取排他锁失败:`, lockConnErr);
    if (lockClient) await lockClient.end().catch(() => {});
    await testPrisma.$disconnect();
    process.exit(1);
  }

  // 4. 启动前历史遗留数据检查（仅输出审计警告，严禁自行批量删除）
  const legacyFound: Record<string, string[]> = {};
  let totalLegacyCount = 0;
  for (const { table, model } of CLEANUP_TABLE_ORDER) {
    if (typeof (testPrisma[model] as any)?.findMany === 'function') {
      const rows = await (testPrisma[model] as any).findMany({
        where: { id: { startsWith: 'drill_' } },
        select: { id: true },
        take: 50,
      });
      if (rows.length > 0) {
        legacyFound[table] = rows.map((r: any) => r.id);
        totalLegacyCount += rows.length;
      }
    }
  }
  if (totalLegacyCount > 0) {
    console.warn(
      `\n⚠️ [DRILL AUDIT WARNING] 发现历史遗留 drill_ 记录（共 ${totalLegacyCount} 条），仅输出记录 ID 供审计排查，绝不执行无条件批量删除：`,
    );
    console.warn(JSON.stringify(legacyFound, null, 2));
    console.warn(
      `如需按历史演练运行精确清理，请使用: npm run backup:restore-drill -- --cleanup-run <drillRunId>\n`,
    );
  }

  // 5. 初始化本次演练 ID 与本地增量 manifest
  const drillRunId = `drill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const manifestPath = path.join(REPORTS_DIR, `manifest-${drillRunId}.json`);
  const manifestData = {
    drillRunId,
    startedAt: new Date().toISOString(),
    createdRecordIds: {} as Record<string, string[]>,
    createdR2Keys: [] as string[],
  };

  const persistManifest = () => {
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf-8');
  };
  const trackId = (table: string, id: string) => {
    if (!manifestData.createdRecordIds[table]) manifestData.createdRecordIds[table] = [];
    if (!manifestData.createdRecordIds[table].includes(id)) {
      manifestData.createdRecordIds[table].push(id);
      persistManifest();
    }
  };
  const trackR2Key = (key: string) => {
    if (!manifestData.createdR2Keys.includes(key)) {
      manifestData.createdR2Keys.push(key);
      persistManifest();
    }
  };
  persistManifest();

  // 6. 服务层与环境配置准备
  process.env.BACKUP_RESTORE_ENABLED = 'true';
  process.env.BACKUP_RESTORE_SEASON_ENABLED = 'true';
  process.env.BACKUP_RESTORE_STAFF_ENABLED = 'true';
  process.env.BACKUP_RESTORE_CONTENT_ENABLED = 'true';
  process.env.BACKUP_RESTORE_MEMBERS_ENABLED = 'true';
  process.env.BACKUP_RESTORE_OPERATIONS_ENABLED = 'true';
  if (!process.env.BACKUP_RESTORE_TOKEN_SECRET) {
    process.env.BACKUP_RESTORE_TOKEN_SECRET = `drill_secret_${drillRunId}`;
  }

  const objectStore = new BackupObjectStoreService();

  // 若无云端 R2 凭据，启用本地内存存储回退以支持无凭据本地/CI隔离演练
  if (!process.env.R2_BUCKET_NAME) {
    const memoryStore = new Map<string, Buffer>();
    (objectStore as any).createUpload = (key: string, _filename: string, body: Readable) => ({
      done: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        memoryStore.set(key, Buffer.concat(chunks));
        return { Location: `mock://${key}` };
      },
      abort: () => {},
    });
    (objectStore as any).getObjectStream = async (key: string) => {
      const buf = memoryStore.get(key);
      if (!buf) throw new Error(`Object not found in drill memory store: ${key}`);
      return Readable.from([buf]);
    };
    (objectStore as any).headObject = async (key: string) => {
      const buf = memoryStore.get(key);
      if (!buf) throw new Error(`Object not found in drill memory store: ${key}`);
      return { ContentLength: buf.length, LastModified: new Date() };
    };
    (objectStore as any).deleteObject = async (key: string) => {
      memoryStore.delete(key);
    };
  }

  const verificationService = new BackupVerificationService(objectStore);
  const scopeService = new BackupScopeService(testPrisma as unknown as PrismaService);
  const planService = new BackupPlanService(scopeService);
  const retentionService = new BackupRetentionService();
  const mockAuditLog: any = { log: async () => true };
  const exportService = new BackupExportService(
    testPrisma as unknown as PrismaService,
    objectStore,
    verificationService,
    mockAuditLog,
    scopeService,
    planService,
  );
  const restoreService = new BackupRestoreService(
    testPrisma as unknown as PrismaService,
    objectStore,
    verificationService,
    exportService,
    mockAuditLog,
  );
  const moduleRestoreService = new BackupModuleRestoreService(
    testPrisma as unknown as PrismaService,
    objectStore,
    verificationService,
    exportService,
    mockAuditLog,
  );
  const uploadService = new BackupUploadService(objectStore, verificationService, mockAuditLog);
  const maintenanceService = new BackupMaintenanceService(
    objectStore,
    verificationService,
    retentionService,
    mockAuditLog,
  );
  const fingerprintService = new BackupFingerprintService(testPrisma as unknown as PrismaService);
  const backupService = new BackupService(
    exportService,
    restoreService,
    uploadService,
    maintenanceService,
    objectStore,
    verificationService,
    scopeService,
    retentionService,
    testPrisma as unknown as PrismaService,
    moduleRestoreService,
    fingerprintService,
  );

  const scenarioResults = {
    activeSeason: { passed: false, durationMs: 0, details: '' },
    archivedSeason: { passed: false, durationMs: 0, details: '' },
    contentModule: { passed: false, durationMs: 0, details: '' },
  };

  const startTime = Date.now();
  console.log(`\n🚀 开始执行自动化隔离恢复演练 [ID: ${drillRunId}]...\n`);

  try {
    // ----------------------------------------------------
    // 场景一：活跃赛季演练 (导出 -> 篡改 -> 预检 -> 恢复 -> 数据一致性校验)
    // ----------------------------------------------------
    const s1Start = Date.now();
    console.log('▶ [1/3] 场景一：活跃赛季恢复演练...');
    const tHomeId = `drill_th_\${drillRunId}`;
    const tAwayId = `drill_ta_\${drillRunId}`;
    const pId = `drill_p_\${drillRunId}`;
    const activeSeasonId = `drill_sa_\${drillRunId}`;
    const mActiveId = `drill_ma_\${drillRunId}`;
    const gActiveId = `drill_ga_\${drillRunId}`;

    await testPrisma.team.create({
      data: {
        id: tHomeId,
        teamName: `主队_\${drillRunId}`,
        gender: 'MALE',
        homeJerseyColor: '红色',
        awayJerseyColor: '白色',
      },
    });
    trackId('Team', tHomeId);
    await testPrisma.team.create({
      data: {
        id: tAwayId,
        teamName: `客队_\${drillRunId}`,
        gender: 'MALE',
        homeJerseyColor: '蓝色',
        awayJerseyColor: '黄色',
      },
    });
    trackId('Team', tAwayId);

    await testPrisma.player.create({
      data: {
        id: pId,
        name: '演练球员',
        studentId: `ST_${drillRunId.slice(-6)}`,
        teamId: tHomeId,
        jerseyNumber: '10',
      },
    });
    trackId('Player', pId);

    await testPrisma.season.create({
      data: { id: activeSeasonId, name: '演练活跃赛季', status: 'active', type: 'LEAGUE' },
    });
    trackId('Season', activeSeasonId);

    await testPrisma.match.create({
      data: {
        id: mActiveId,
        seasonId: activeSeasonId,
        homeTeamId: tHomeId,
        awayTeamId: tAwayId,
        homeScore: 2,
        awayScore: 1,
        matchDate: new Date(),
        location: '演练场地',
        status: 'completed',
        stage: 'GROUP',
      },
    });
    trackId('Match', mActiveId);

    await testPrisma.goal.create({
      data: {
        id: gActiveId,
        matchId: mActiveId,
        playerId: pId,
        playerName: '演练球员',
        jerseyNumber: '10',
        goalTime: "20'",
        teamType: 'home',
      },
    });
    trackId('Goal', gActiveId);

    // 导出备份
    const backupActive = await backupService.createBackup('admin', {
      scope: 'module',
      module: 'season',
      selector: { seasonId: activeSeasonId },
      purpose: 'manual',
    });
    trackR2Key(backupActive.key);

    // 篡改数据：删除进球，修改比分
    await testPrisma.goal.delete({ where: { id: gActiveId } });
    await testPrisma.match.update({ where: { id: mActiveId }, data: { homeScore: 99 } });

    // 预检与恢复
    const previewActive = await backupService.previewRestore('admin', backupActive.key);
    if (!previewActive.canExecute) throw new Error('活跃赛季恢复 Preview 未通过');

    await backupService.restoreModuleBackup(
      'admin',
      backupActive.key,
      previewActive.restoreToken,
      'CONFIRM_MODULE_RESTORE',
    );

    // 校验数据已恢复
    const restoredMatch = await testPrisma.match.findUnique({ where: { id: mActiveId } });
    const restoredGoal = await testPrisma.goal.findUnique({ where: { id: gActiveId } });
    if (restoredMatch?.homeScore !== 2 || !restoredGoal) {
      throw new Error(
        `活跃赛季恢复数据一致性校验失败: 比分预期 2 实为 ${restoredMatch?.homeScore}, 进球存在: ${!!restoredGoal}`,
      );
    }
    scenarioResults.activeSeason = {
      passed: true,
      durationMs: Date.now() - s1Start,
      details: `成功恢复比赛比分(2-1)与进球数据，耗时 ${Date.now() - s1Start}ms`,
    };
    console.log(`  ✓ 场景一通过 (${scenarioResults.activeSeason.durationMs}ms)`);

    // ----------------------------------------------------
    // 场景二：归档赛季演练 (受保护归档备份 -> 篡改 -> 恢复 -> 对照赛季隔离校验)
    // ----------------------------------------------------
    const s2Start = Date.now();
    console.log('▶ [2/3] 场景二：归档赛季恢复与跨赛季隔离演练...');
    const archSeasonId = `drill_sarch_${drillRunId}`;
    const archMatchId = `drill_march_${drillRunId}`;
    const ctrlSeasonId = `drill_sctrl_${drillRunId}`;
    const ctrlMatchId = `drill_mctrl_${drillRunId}`;

    await testPrisma.season.create({
      data: { id: archSeasonId, name: '演练归档赛季', status: 'completed', type: 'CUP' },
    });
    trackId('Season', archSeasonId);

    await testPrisma.match.create({
      data: {
        id: archMatchId,
        seasonId: archSeasonId,
        homeTeamId: tHomeId,
        awayTeamId: tAwayId,
        homeScore: 3,
        awayScore: 0,
        matchDate: new Date(),
        location: '演练场地B',
        status: 'completed',
        stage: 'FINAL',
      },
    });
    trackId('Match', archMatchId);

    // 对照赛季（用于验证跨赛季隔离）
    await testPrisma.season.create({
      data: { id: ctrlSeasonId, name: '对照隔离赛季', status: 'active', type: 'LEAGUE' },
    });
    trackId('Season', ctrlSeasonId);

    await testPrisma.match.create({
      data: {
        id: ctrlMatchId,
        seasonId: ctrlSeasonId,
        homeTeamId: tHomeId,
        awayTeamId: tAwayId,
        homeScore: 1,
        awayScore: 1,
        matchDate: new Date(),
        location: '对照场地',
        status: 'completed',
        stage: 'GROUP',
      },
    });
    trackId('Match', ctrlMatchId);

    const backupArch = await backupService.createBackup('admin', {
      scope: 'module',
      module: 'season',
      selector: { seasonId: archSeasonId },
      purpose: 'archive',
      protected: true,
    });
    trackR2Key(backupArch.key);

    // 篡改归档赛季比赛
    await testPrisma.match.update({ where: { id: archMatchId }, data: { homeScore: 0 } });

    // 预检并恢复归档赛季
    const previewArch = await backupService.previewRestore('admin', backupArch.key);
    await backupService.restoreModuleBackup(
      'admin',
      backupArch.key,
      previewArch.restoreToken,
      'CONFIRM_MODULE_RESTORE',
    );

    // 验证归档赛季恢复且对照赛季未被破坏
    const restoredArchMatch = await testPrisma.match.findUnique({ where: { id: archMatchId } });
    const untouchedCtrlMatch = await testPrisma.match.findUnique({ where: { id: ctrlMatchId } });
    if (restoredArchMatch?.homeScore !== 3) {
      throw new Error(`归档赛季恢复失败: 预期比分 3 实为 ${restoredArchMatch?.homeScore}`);
    }
    if (untouchedCtrlMatch?.homeScore !== 1 || untouchedCtrlMatch?.awayScore !== 1) {
      throw new Error('对照隔离赛季数据被破坏，跨赛季隔离失败！');
    }
    scenarioResults.archivedSeason = {
      passed: true,
      durationMs: Date.now() - s2Start,
      details: `归档赛季成功恢复(3-0)，对照赛季(1-1)严格隔离未受污染，耗时 ${Date.now() - s2Start}ms`,
    };
    console.log(`  ✓ 场景二通过 (${scenarioResults.archivedSeason.durationMs}ms)`);

    // ----------------------------------------------------
    // 场景三：非赛季模块演练 (content 新闻模块)
    // ----------------------------------------------------
    const s3Start = Date.now();
    console.log('▶ [3/3] 场景三：内容模块 (content) 增量恢复演练...');
    const newsId = `drill_n_${drillRunId}`;
    await testPrisma.news.create({
      data: {
        id: newsId,
        title: '演练新闻原始标题',
        category: 'NEWS',
        content: '演练新闻原始内容',
        description: '演练摘要',
        published: true,
        publishedAt: new Date(),
        date: '2026-09-11',
      },
    });
    trackId('News', newsId);

    const backupContent = await backupService.createBackup('admin', {
      scope: 'module',
      module: 'content',
      selector: {},
    });
    trackR2Key(backupContent.key);

    // 篡改新闻标题
    await testPrisma.news.update({
      where: { id: newsId },
      data: { title: '篡改后的新闻标题' },
    });

    const previewContent = await backupService.previewRestore('admin', backupContent.key);
    await backupService.restoreModuleBackup(
      'admin',
      backupContent.key,
      previewContent.restoreToken,
      'CONFIRM_MODULE_RESTORE',
    );

    const restoredNews = await testPrisma.news.findUnique({ where: { id: newsId } });
    if (restoredNews?.title !== '演练新闻原始标题') {
      throw new Error(`内容模块恢复一致性校验失败: 实为 ${restoredNews?.title}`);
    }
    scenarioResults.contentModule = {
      passed: true,
      durationMs: Date.now() - s3Start,
      details: `成功恢复新闻文章标题与内容，耗时 ${Date.now() - s3Start}ms`,
    };
    console.log(`  ✓ 场景三通过 (${scenarioResults.contentModule.durationMs}ms)`);
  } catch (drillErr: any) {
    console.error('\n❌ 恢复演练过程中发生异常:', drillErr);
    throw drillErr;
  } finally {
    const totalDurationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n🧹 [FINALLY] 正在执行精准资源销毁与演练清理...');

    const cleanupSummary = {
      dbDeleted: {} as Record<string, { expected: number; actual: number; error?: string }>,
      r2Deleted: [] as string[],
      r2Failed: [] as Array<{ key: string; error: string }>,
      lockReleased: false,
      lockError: null as string | null,
    };

    // 逐表按外键反向顺序删除精准 ID
    for (const { table, model } of CLEANUP_TABLE_ORDER) {
      const ids = manifestData.createdRecordIds[table];
      if (ids && ids.length > 0) {
        try {
          if (typeof (testPrisma[model] as any)?.deleteMany === 'function') {
            const delRes = await (testPrisma[model] as any).deleteMany({
              where: { id: { in: ids } },
            });
            cleanupSummary.dbDeleted[table] = { expected: ids.length, actual: delRes.count };
            console.log(`  - ${table}: 精准删除 ${delRes.count}/${ids.length} 条演练记录`);
          }
        } catch (delErr: any) {
          const errMsg = delErr instanceof Error ? delErr.message : String(delErr);
          console.warn(`  ! 清理 ${table} 记录异常:`, delErr);
          cleanupSummary.dbDeleted[table] = {
            expected: ids.length,
            actual: 0,
            error: errMsg,
          };
        }
      }
    }

    // 清理 R2 对象
    for (const key of manifestData.createdR2Keys) {
      try {
        await objectStore.deleteObject(key);
        cleanupSummary.r2Deleted.push(key);
        console.log(`  - R2: 已删除演练快照 ${key}`);
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`  ! 删除 R2 对象异常: ${key}`, err);
        cleanupSummary.r2Failed.push({ key, error: errMsg });
      }
    }

    // 释放 Advisory Lock（在同一专用物理连接上执行，并严格校验返回值）
    if (lockClient && lockAcquired) {
      try {
        const unlockRes = await lockClient.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1) AS unlocked',
          [ADVISORY_LOCK_ID],
        );
        const wasUnlocked = unlockRes.rows[0]?.unlocked === true;
        if (wasUnlocked) {
          cleanupSummary.lockReleased = true;
          console.log(`  - Advisory Lock (${ADVISORY_LOCK_ID}) 已在专属连接上成功释放`);
        } else {
          cleanupSummary.lockReleased = false;
          cleanupSummary.lockError = `pg_advisory_unlock 返回 false (专属连接未持有此锁或已被释放)`;
          console.warn(`  ! Advisory Lock 释放异常: 返回 false`);
        }
      } catch (unlockErr: any) {
        const errMsg = unlockErr instanceof Error ? unlockErr.message : String(unlockErr);
        console.warn('  ! 释放 Advisory Lock 异常:', unlockErr);
        cleanupSummary.lockReleased = false;
        cleanupSummary.lockError = errMsg;
      } finally {
        await lockClient.end().catch(() => {});
      }
    }

    await testPrisma.$disconnect();

    // 生成 Markdown 演练报告（数据库连接串敏感密码脱敏）
    const maskedUrl = new URL(testDbUrl);
    if (maskedUrl.password) maskedUrl.password = '***';
    const allPassed =
      scenarioResults.activeSeason.passed &&
      scenarioResults.archivedSeason.passed &&
      scenarioResults.contentModule.passed;

    const hasDbCleanupFailures = Object.values(cleanupSummary.dbDeleted).some(
      (d) => !!d.error || d.actual < d.expected,
    );
    const hasR2CleanupFailures = cleanupSummary.r2Failed.length > 0;
    const cleanupPassed =
      !hasDbCleanupFailures && !hasR2CleanupFailures && cleanupSummary.lockReleased;

    let finalRating: string;
    if (!allPassed) {
      finalRating = '❌ 存在业务演练失败场景 (FAILED)';
    } else if (!cleanupPassed) {
      finalRating = '⚠️ 业务场景通过但演练清理存在失败 (CLEANUP_FAILED)';
    } else {
      finalRating = '✅ 全部场景与清理确认通过 (ALL PASSED)';
    }

    const reportPath = path.join(REPORTS_DIR, `restore-drill-report-${drillRunId}.md`);
    const dbReportLines: string[] = [];
    for (const [table, stat] of Object.entries(cleanupSummary.dbDeleted)) {
      if (stat.error) {
        dbReportLines.push(
          `  - \`${table}\`: ❌ 清理失败: ${stat.error} (预期 ${stat.expected} 笔)`,
        );
      } else if (stat.actual < stat.expected) {
        dbReportLines.push(
          `  - \`${table}\`: ⚠️ 部分清理: 实际销毁 ${stat.actual}/${stat.expected} 笔`,
        );
      } else {
        dbReportLines.push(
          `  - \`${table}\`: ✅ 已确认精准销毁 ${stat.actual}/${stat.expected} 笔记录`,
        );
      }
    }

    const reportMd = [
      '# 数据库模块恢复自动化演练报告',
      '',
      `- **演练编号 (Drill Run ID)**: \`${drillRunId}\``,
      `- **执行时间**: \`${new Date().toISOString()}\``,
      `- **演练总耗时**: \`${totalDurationSeconds} 秒\``,
      `- **测试数据库**: \`${maskedUrl.toString()}\``,
      `- **最终评定**: ${finalRating}`,
      '',
      '## 1. 演练场景执行详情',
      '',
      '| 场景编号 | 场景名称 | 演练操作与验证重点 | 场景状态 | 耗时 |',
      '| :--- | :--- | :--- | :--- | :--- |',
      `| 1 | 活跃赛季恢复 | 备份 -> 篡改比分进球 -> 预检 -> 恢复校验 | ${scenarioResults.activeSeason.passed ? '✅ 通过' : '❌ 失败'} | ${scenarioResults.activeSeason.durationMs}ms |`,
      `| 2 | 归档赛季与隔离 | 归档备份 -> 篡改 -> 恢复 -> 对照赛季隔离 | ${scenarioResults.archivedSeason.passed ? '✅ 通过' : '❌ 失败'} | ${scenarioResults.archivedSeason.durationMs}ms |`,
      `| 3 | 内容模块恢复 | 新闻备份 -> 篡改标题 -> 预检 -> 恢复校验 | ${scenarioResults.contentModule.passed ? '✅ 通过' : '❌ 失败'} | ${scenarioResults.contentModule.durationMs}ms |`,
      '',
      '## 2. 演练清理与安全审计',
      '',
      `- **本地增量 Manifest**: \`scripts/drill-reports/manifest-${drillRunId}.json\``,
      '- **数据清理策略**: 仅根据 manifest 中记录的精确主键按逆向外键顺序执行精确删除，严禁前缀通配扫表。',
      `- **清理状态核验**: ${cleanupPassed ? '✅ 全部演练资源确认物理销毁' : '❌ 演练资源清理存在异常或残留'}`,
      '- **数据库记录销毁核验**:',
      ...(dbReportLines.length > 0 ? dbReportLines : ['  - 无新增数据库记录需清理']),
      '- **对象存储 (R2) 销毁核验**:',
      `  - 确认成功删除: ${cleanupSummary.r2Deleted.length} 笔`,
      ...cleanupSummary.r2Deleted.map((k) => `    - ✅ \`${k}\`: 已物理删除`),
      ...(cleanupSummary.r2Failed.length > 0
        ? [
            `  - ❌ 删除失败: ${cleanupSummary.r2Failed.length} 笔`,
            ...cleanupSummary.r2Failed.map((f) => `    - ❌ \`${f.key}\`: ${f.error}`),
          ]
        : []),
      `- **独占锁状态**: ${
        cleanupSummary.lockReleased
          ? `✅ Advisory Lock (${ADVISORY_LOCK_ID}) 已成功释放`
          : `❌ Advisory Lock 释放失败: ${cleanupSummary.lockError}`
      }`,
      '',
      '---\n*本报告由 scripts/backup-restore-drill.ts 自动生成，已纳入 .gitignore 保护，严禁上传生产敏感信息。*',
    ].join('\n');

    fs.writeFileSync(reportPath, reportMd, 'utf-8');
    console.log(`\n📄 演练脱敏报告已生成: ${reportPath}\n`);
  }
}

main().catch((err) => {
  console.error('[DRILL FATAL EXCEPTION]', err);
  process.exit(1);
});
