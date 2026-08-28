const { spawnSync } = require('node:child_process');

const environment = { ...process.env };
// 临时只读诊断：仅开发预览输出主机名，不连接数据库或输出凭证。
if (
  environment.VERCEL_ENV === 'preview' &&
  environment.VERCEL_GIT_COMMIT_REF === 'develop'
) {
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    try {
      const hostname = new URL(environment[key]).hostname;
      console.log(`[开发库主机核对] ${key}: ${hostname}`);
    } catch {
      console.log(`[开发库主机核对] ${key}: 未配置或格式无效`);
    }
  }
}
const isDatabaseLessPreview =
  environment.VERCEL_ENV === 'preview' &&
  !environment.DIRECT_URL &&
  !environment.DATABASE_URL_UNPOOLED &&
  !environment.DATABASE_URL;
const shouldRunMigrations = environment.VERCEL_ENV === 'production';

if (isDatabaseLessPreview) {
  // Preview deployments may intentionally have no database connection. Prisma
  // still needs a syntactically valid URL while generating the client, but no
  // connection is opened during generation or application compilation.
  environment.DIRECT_URL = 'postgresql://preview:preview@127.0.0.1:5432/preview';
  environment.DATABASE_URL = environment.DIRECT_URL;
  console.log('Vercel preview build: database is not connected; skipping migrations.');
} else if (environment.VERCEL_ENV === 'preview') {
  console.log(
    'Vercel preview build: database variables are available, but migrations are reserved for production.',
  );
}

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
  ...(shouldRunMigrations ? [[process.execPath, ['scripts/run-vercel-migrations.js']]] : []),
  [executable, ['nest', 'build']],
  [process.execPath, ['copy-swagger.js']],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === executable,
  });

  if (result.error) {
    console.error(`Vercel 构建步骤启动失败：${command} ${args.join(' ')}`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
