/**
 * 旧版 `backups/` 备份镜像安全迁移状态机 CLI 脚本
 */
import { S3Client } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import { executeMigrationMachine } from './migrate-old-backups-core';

dotenv.config();

const args = process.argv.slice(2);
const isCopy = args.includes('--copy');
const isVerify = args.includes('--verify');
const isDeleteSource = args.includes('--delete-source');
const confirmDeleteArg = args.find((a) => a.startsWith('--confirm-delete='));
const confirmDeleteText = confirmDeleteArg ? confirmDeleteArg.split('=')[1] : '';

const isDryRun = (!isCopy && !isVerify && !isDeleteSource) || args.includes('--dry-run');

async function runCli() {
  console.log('=== 旧版 backups/ 备份迁移与校验状态机 ===');
  console.log(
    `当前运行模式: ${isDryRun ? '[DRY-RUN 预审]' : ''} ${isCopy ? '[COPY 复制]' : ''} ${
      isVerify ? '[VERIFY 校验]' : ''
    } ${isDeleteSource ? '[DELETE-SOURCE 删除源]' : ''}`,
  );

  if (!process.env.R2_BUCKET_NAME || !process.env.R2_ENDPOINT) {
    console.error('[错误] 缺少必要 R2 环境变量 (R2_BUCKET_NAME, R2_ENDPOINT)');
    process.exit(1);
  }

  const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });

  const result = await executeMigrationMachine(s3Client, process.env.R2_BUCKET_NAME, {
    isDryRun,
    isCopy,
    isVerify,
    isDeleteSource,
    confirmDeleteText,
  });

  console.log(`\n1. 盘点源目录 backups/ 共发现 ${result.sourceObjects.length} 个 JSON 备份对象`);

  if (result.sourceObjects.length === 0) {
    console.log('没有检测到需要迁移的旧版备份对象。');
    return;
  }

  console.log('\n2. 执行备份对象结构校验与预审分类:');
  for (const obj of result.sourceObjects) {
    const item = result.classifications[obj.Key];
    console.log(
      ` - ${obj.Key} -> ${item.targetKey} | 类别: [${item.category.toUpperCase()}] | 判定依据: ${item.reason}`,
    );
  }

  if (isDryRun) {
    console.log('\n[Dry-Run 模式预审完结] 零写零删。');
    const counts = { active: 0, 'legacy-archive': 0, quarantine: 0 };
    Object.values(result.classifications).forEach((item) => {
      counts[item.category as keyof typeof counts]++;
    });
    console.log(` - 活跃恢复目录 (private-backups/database/): ${counts.active} 个`);
    console.log(
      ` - 只读归档目录 (private-backups/legacy-archive/): ${counts['legacy-archive']} 个`,
    );
    console.log(` - 异常隔离目录 (private-backups/quarantine/): ${counts.quarantine} 个`);
    return;
  }

  if (isVerify && !result.success) {
    console.error('\n[错误] 校验末尾失败，存在不一致的目标对象！');
    process.exit(1);
  }
}

runCli().catch((err) => {
  console.error('迁移状态机运行崩溃:', err);
  process.exit(1);
});
