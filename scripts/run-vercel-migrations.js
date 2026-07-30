const { spawnSync } = require('node:child_process');

const environment = { ...process.env };

// 开发预览环境可能同时触发多次构建，共用数据库时容易被遗留的
// PostgreSQL advisory lock 阻塞。仅在 Vercel Preview 中关闭 Prisma
// 迁移锁；生产环境继续保留迁移锁保护。
if (environment.VERCEL_ENV === 'preview') {
  environment.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK = '1';
  console.log('Vercel Preview：已关闭 Prisma advisory lock，开始执行数据库迁移。');
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(executable, ['prisma', 'migrate', 'deploy'], {
  env: environment,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Prisma 数据库迁移启动失败：', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
