const { spawnSync } = require('node:child_process');

const environment = { ...process.env };
const isDatabaseLessPreview =
  environment.VERCEL_ENV === 'preview' &&
  !environment.DIRECT_URL &&
  !environment.DATABASE_URL_UNPOOLED &&
  !environment.DATABASE_URL;

if (isDatabaseLessPreview) {
  // Preview deployments may intentionally have no database connection. Prisma
  // still needs a syntactically valid URL while generating the client, but no
  // connection is opened during generation or application compilation.
  environment.DIRECT_URL =
    'postgresql://preview:preview@127.0.0.1:5432/preview';
  environment.DATABASE_URL = environment.DIRECT_URL;
  console.log(
    'Vercel preview build: database is not connected; skipping migrations.',
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
  ...(!isDatabaseLessPreview
    ? [[process.execPath, ['scripts/run-vercel-migrations.js']]]
    : []),
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
