const { spawnSync } = require('node:child_process');

const environment = { ...process.env };

if (!environment.DIRECT_URL) {
  const fallbackName = environment.DATABASE_URL_UNPOOLED
    ? 'DATABASE_URL_UNPOOLED'
    : environment.DATABASE_URL
      ? 'DATABASE_URL'
      : null;

  if (!fallbackName) {
    console.error('Vercel 构建失败：缺少 DIRECT_URL、DATABASE_URL_UNPOOLED 和 DATABASE_URL。');
    process.exit(1);
  }

  environment.DIRECT_URL = environment[fallbackName];
  console.log(`Vercel 构建：DIRECT_URL 未配置，使用当前项目的 ${fallbackName}。`);
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const steps = [
  [executable, ['prisma', 'generate']],
  [process.execPath, ['scripts/run-vercel-migrations.js']],
  [executable, ['nest', 'build']],
  [process.execPath, ['copy-swagger.js']],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Vercel 构建步骤启动失败：${command} ${args.join(' ')}`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
