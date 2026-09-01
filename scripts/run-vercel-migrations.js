const { spawnSync } = require('node:child_process');

const environment = { ...process.env };
const recoverableMigration = '20260807200000_add_admin_form_drafts';
const retryableMigrations = [
  '20260806202000_restore_evidenced_season_team_profiles',
  '20260810162500_add_manual_champion_fields',
];

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// 旧版预览构建关闭了 Prisma advisory lock，并发部署可能为这条迁移留下
// P3009 失败记录。只将这一条已知失败记录标记为已处理，随后由新的前向
// 修复迁移补齐表和索引；若目标数据库没有该失败记录，resolve 会失败，
// 但后续 migrate deploy 仍会按正常流程执行并给出真实结果。
const recovery = spawnSync(
  executable,
  ['prisma', 'migrate', 'resolve', '--applied', recoverableMigration],
  {
    env: environment,
    encoding: 'utf8',
  },
);

if (recovery.status === 0) {
  console.log(`Vercel 构建：已处理失败迁移 ${recoverableMigration}，准备执行前向修复。`);
}

// This migration could fail on legacy matches that have no season assigned.
// The SQL now excludes those rows, so roll back only its failed migration
// record and let `migrate deploy` retry it safely.
for (const retryableMigration of retryableMigrations) {
  const retryRecovery = spawnSync(
    executable,
    ['prisma', 'migrate', 'resolve', '--rolled-back', retryableMigration],
    {
      env: environment,
      encoding: 'utf8',
    },
  );

  if (retryRecovery.status === 0) {
    console.log(
      `Vercel build: recovered failed migration ${retryableMigration}; preparing a safe retry.`,
    );
  }
}

// 不再关闭 advisory lock，避免共享预览数据库上的并发迁移互相破坏。
delete environment.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK;

const maxAttempts = 3;
let finalStatus = 1;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(executable, ['prisma', 'migrate', 'deploy'], {
    env: environment,
    encoding: 'utf8',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    console.error('Prisma 数据库迁移启动失败：', result.error.message);
    finalStatus = 1;
    break;
  }

  finalStatus = result.status ?? 1;
  if (finalStatus === 0) {
    process.exit(0);
  }

  const migrationOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const isTemporaryConnectionFailure = migrationOutput.includes('P1001');
  if (!isTemporaryConnectionFailure || attempt === maxAttempts) {
    break;
  }

  if (
    attempt === 1 &&
    environment.DATABASE_URL &&
    environment.DATABASE_URL !== environment.DIRECT_URL
  ) {
    environment.DIRECT_URL = environment.DATABASE_URL;
    console.warn(
      'Vercel 构建：数据库直连端点不可用，后续迁移改用当前项目的运行时连接池。',
    );
  }

  const delayMs = attempt * 5000;
  console.warn(
    `Vercel 构建：数据库暂时无法连接（P1001），${delayMs / 1000} 秒后进行第 ${attempt + 1} 次迁移尝试。`,
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

process.exit(finalStatus);
