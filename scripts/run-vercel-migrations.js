const { spawnSync } = require('node:child_process');

const environment = { ...process.env };
const recoverableMigration = '20260807200000_add_admin_form_drafts';

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

// 不再关闭 advisory lock，避免共享预览数据库上的并发迁移互相破坏。
delete environment.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK;

const result = spawnSync(executable, ['prisma', 'migrate', 'deploy'], {
  env: environment,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Prisma 数据库迁移启动失败：', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
