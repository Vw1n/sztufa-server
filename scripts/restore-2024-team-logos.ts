import { PrismaClient } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { SeasonStatisticsService } from '../src/prisma/season-statistics.service';
import { LeagueStandingsCalculator } from '../src/prisma/league-standings.calculator';
import { CupStandingsCalculator } from '../src/prisma/cup-standings.calculator';
import { PlayerStatisticsCalculator } from '../src/prisma/player-statistics.calculator';

const prisma = new PrismaClient();

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const getPublicUrl = (key: string): string => {
  const baseUrl = (process.env.R2_PUBLIC_URL || 'https://assets.sztufa.xyz').replace(/\/$/, '');
  const cleanKey = key.replace(/^\//, '');
  return `${baseUrl}/${cleanKey}`;
};

const validateImageMagicBytes = (buffer: Buffer): boolean => {
  if (!buffer || buffer.length < 4) return false;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isGif =
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  const isWebp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return isPng || isJpeg || isGif || isWebp;
};

async function validateRemoteImageUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  if (!url.startsWith('https://')) {
    return { valid: false, error: 'URL 必须使用安全 HTTPS 协议' };
  }
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return { valid: false, error: `HTTP 响应状态码为 ${resp.status} (${resp.statusText})` };
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return { valid: false, error: `Content-Type 不是图片: ${contentType}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `远程连接校验失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface LogoMapping {
  [teamNameOrId: string]: string; // URL or local file path
}

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply') || args.includes('--execute');
  const seasonIdArg = args.find((a) => a.startsWith('--season-id='))?.split('=')[1];
  const mappingFileArg = args.find((a) => a.startsWith('--mapping='))?.split('=')[1];
  const dirArg = args.find((a) => a.startsWith('--dir='))?.split('=')[1];

  console.log('=== 2024 赛季球队队徽检查与恢复工具 ===');
  console.log(`模式: ${isApply ? '【执行模式 --apply】' : '【只读预览 DRY-RUN】'}`);

  if (isApply && !seasonIdArg) {
    console.error(
      '❌ 【安全拦截】执行写入模式 (--apply) 必须显式提供 --season-id=<seasonId>，禁止依赖模糊匹配！',
    );
    process.exit(1);
  }

  let season = null;
  if (seasonIdArg) {
    season = await prisma.season.findUnique({ where: { id: seasonIdArg } });
  } else {
    season = await prisma.season.findFirst({
      where: {
        OR: [{ id: 'cmsihsd8k0001gja2qkmdh66c' }, { name: { contains: '2024' } }],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!season) {
    console.error('未找到指定的 2024 目标赛季！');
    process.exit(1);
  }

  console.log(`目标赛季: [${season.id}] ${season.name} (status: ${season.status})`);

  let mapping: LogoMapping = {};
  if (mappingFileArg) {
    const fullPath = path.resolve(process.cwd(), mappingFileArg);
    if (fs.existsSync(fullPath)) {
      mapping = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      console.log(`已加载映射文件: ${fullPath} (${Object.keys(mapping).length} 条映射)`);
    } else {
      console.warn(`指定的映射文件不存在: ${fullPath}`);
    }
  }

  const profiles = await prisma.seasonTeamProfile.findMany({
    where: { seasonId: season.id },
    include: { team: true },
  });

  console.log(`\n找到该赛季下的 ${profiles.length} 支参赛球队 Profile:`);
  const plannedRestores: Array<{
    profileId: string;
    teamId: string;
    teamName: string;
    currentLogo: string | null;
    sourceType: 'local_file' | 'remote_url' | 'temp_url';
    sourcePathOrUrl: string;
    targetFormalKey: string;
  }> = [];

  for (const profile of profiles) {
    const teamName = profile.teamName || profile.team.teamName;
    const currentLogo = profile.teamLogo;
    let rawSource = mapping[teamName] || mapping[profile.teamId] || mapping[profile.id];

    if (!rawSource && dirArg) {
      const candidateExts = ['.webp', '.png', '.jpg', '.jpeg', '.gif'];
      for (const ext of candidateExts) {
        const byName = path.resolve(process.cwd(), dirArg, `${teamName}${ext}`);
        const byId = path.resolve(process.cwd(), dirArg, `${profile.teamId}${ext}`);
        if (fs.existsSync(byName)) {
          rawSource = byName;
          break;
        }
        if (fs.existsSync(byId)) {
          rawSource = byId;
          break;
        }
      }
    }

    if (!rawSource && profile.team.teamLogo && !profile.team.teamLogo.includes('temp/')) {
      rawSource = profile.team.teamLogo;
    }

    console.log(`- 球队: ${teamName} (ID: ${profile.teamId})`);
    console.log(`  当前 Profile 队徽: ${currentLogo || '【空】'}`);

    if (rawSource) {
      const safeName = teamName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      const targetFormalKey = `uploads/teams/${profile.teamId}/logo/${Date.now()}_restored_${safeName}.webp`;

      if (rawSource.startsWith('http://') || rawSource.startsWith('https://')) {
        if (rawSource.includes('/temp/')) {
          console.log(`  -> 拟从临时 URL 转存为正式对象: ${rawSource}`);
          plannedRestores.push({
            profileId: profile.id,
            teamId: profile.teamId,
            teamName,
            currentLogo,
            sourceType: 'temp_url',
            sourcePathOrUrl: rawSource,
            targetFormalKey,
          });
        } else {
          const check = await validateRemoteImageUrl(rawSource);
          if (check.valid) {
            console.log(`  -> 拟恢复为已有有效正式 URL: ${rawSource}`);
            plannedRestores.push({
              profileId: profile.id,
              teamId: profile.teamId,
              teamName,
              currentLogo,
              sourceType: 'remote_url',
              sourcePathOrUrl: rawSource,
              targetFormalKey,
            });
          } else {
            console.warn(`  -> ❌ 远程 URL 校验失败 (${check.error}): ${rawSource}`);
          }
        }
      } else {
        const localPath = path.resolve(process.cwd(), rawSource);
        if (fs.existsSync(localPath)) {
          const buffer = fs.readFileSync(localPath);
          if (validateImageMagicBytes(buffer)) {
            console.log(`  -> 拟读取本地图片并转码上传: ${localPath} (${buffer.length} bytes)`);
            plannedRestores.push({
              profileId: profile.id,
              teamId: profile.teamId,
              teamName,
              currentLogo,
              sourceType: 'local_file',
              sourcePathOrUrl: localPath,
              targetFormalKey,
            });
          } else {
            console.warn(`  -> ❌ 本地文件格式不受支持(魔数校验失败): ${localPath}`);
          }
        } else {
          console.warn(`  -> ❌ 指定的本地文件不存在: ${localPath}`);
        }
      }
    } else {
      console.log(`  -> ⚠️ 未找到可用的恢复资源 (当前队徽: ${currentLogo || '空'})`);
    }
  }

  console.log(`\n统计: 共有 ${plannedRestores.length} 支球队具备确定的恢复方案。`);

  if (!isApply) {
    console.log('\n[DRY-RUN] 当前为只读预览模式，未执行任何 S3 上传或数据库修改。');
    console.log('如需执行实际恢复，请添加 --apply 参数:');
    console.log(
      `npx ts-node scripts/restore-2024-team-logos.ts --season-id=${season.id} --mapping=logos.json --apply`,
    );
    return;
  }

  if (plannedRestores.length === 0) {
    console.log('无待恢复的球队。');
    return;
  }

  if (!process.env.R2_BUCKET_NAME) {
    console.error('环境变量 R2_BUCKET_NAME 未配置，无法上传至 R2 存储桶！');
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET_NAME;
  const executedUpdates: Array<{
    profileId: string;
    teamName: string;
    finalFormalUrl: string;
  }> = [];
  const newlyCreatedFormalKeys: string[] = [];
  const failedUploads: Array<{ teamName: string; error: string }> = [];

  console.log('\n=== 第一阶段: 处理并上传图片至 R2 正式目录 ===');
  for (const item of plannedRestores) {
    try {
      if (item.sourceType === 'local_file') {
        const rawBuffer = fs.readFileSync(item.sourcePathOrUrl);
        const webpBuffer = await sharp(rawBuffer)
          .rotate()
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: item.targetFormalKey,
            Body: webpBuffer,
            ContentType: 'image/webp',
          }),
        );
        newlyCreatedFormalKeys.push(item.targetFormalKey);
        const formalUrl = getPublicUrl(item.targetFormalKey);
        executedUpdates.push({
          profileId: item.profileId,
          teamName: item.teamName,
          finalFormalUrl: formalUrl,
        });
        console.log(`✔ [本地转码上传成功] ${item.teamName} -> ${formalUrl}`);
      } else if (item.sourceType === 'temp_url') {
        const baseUrl = (process.env.R2_PUBLIC_URL || 'https://assets.sztufa.xyz').replace(
          /\/$/,
          '',
        );
        const sourceKey = item.sourcePathOrUrl.startsWith(`${baseUrl}/`)
          ? item.sourcePathOrUrl.substring(baseUrl.length + 1)
          : item.sourcePathOrUrl;

        await s3Client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${sourceKey}`,
            Key: item.targetFormalKey,
          }),
        );
        newlyCreatedFormalKeys.push(item.targetFormalKey);
        const formalUrl = getPublicUrl(item.targetFormalKey);
        executedUpdates.push({
          profileId: item.profileId,
          teamName: item.teamName,
          finalFormalUrl: formalUrl,
        });
        console.log(`✔ [临时对象复制成功] ${item.teamName} -> ${formalUrl}`);
      } else {
        executedUpdates.push({
          profileId: item.profileId,
          teamName: item.teamName,
          finalFormalUrl: item.sourcePathOrUrl,
        });
        console.log(`✔ [直接引用正式URL] ${item.teamName} -> ${item.sourcePathOrUrl}`);
      }
    } catch (uploadErr) {
      const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
      console.error(`❌ 处理球队 [${item.teamName}] 队徽上传失败:`, errMsg);
      failedUploads.push({ teamName: item.teamName, error: errMsg });
    }
  }

  console.log('\n=== 第二阶段: 事务写入数据库与记录审计日志 ===');
  try {
    await prisma.$transaction(async (tx) => {
      for (const update of executedUpdates) {
        await tx.seasonTeamProfile.update({
          where: { id: update.profileId },
          data: { teamLogo: update.finalFormalUrl },
        });

        if (season.status === 'active') {
          const profile = await tx.seasonTeamProfile.findUnique({
            where: { id: update.profileId },
            select: { teamId: true },
          });
          if (profile?.teamId) {
            await tx.team.update({
              where: { id: profile.teamId },
              data: { teamLogo: update.finalFormalUrl },
            });
          }
        }

        await tx.auditLog.create({
          data: {
            username: 'system-restore',
            action: 'RESTORE_TEAM_LOGO',
            details: `恢复赛季 [${season.name}] 球队 [${update.teamName}] 队徽: ${update.finalFormalUrl}`,
          },
        });
        console.log(`✔ 数据库已更新: [${update.teamName}] 队徽 -> ${update.finalFormalUrl}`);
      }
    });
  } catch (txErr) {
    if (newlyCreatedFormalKeys.length > 0) {
      console.error(
        `❌ 数据库事务失败，启动 R2 补偿清理 ${newlyCreatedFormalKeys.length} 个新创建的正式对象...`,
      );
      try {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: newlyCreatedFormalKeys.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        console.log('✔ 已成功补偿清理新上传的孤儿对象');
      } catch (cleanupErr) {
        console.error('❌ R2 补偿清理异常:', cleanupErr);
      }
    }
    throw txErr;
  }

  console.log('\n=== 第三阶段: 重新计算并刷新赛季积分榜与技术统计缓存 ===');
  const leagueCalculator = new LeagueStandingsCalculator();
  const cupCalculator = new CupStandingsCalculator();
  const playerCalculator = new PlayerStatisticsCalculator();
  const statsService = new SeasonStatisticsService(
    prisma as any,
    leagueCalculator,
    cupCalculator,
    playerCalculator,
  );

  const cacheRes = await statsService.computeAndCache(season.id);
  if (cacheRes.success) {
    console.log(`✔ 赛季 [${season.name}] 统计缓存重建成功！`);
  } else {
    console.warn(`⚠️ 赛季统计缓存重建未完全成功: ${cacheRes.error}`);
  }

  if (failedUploads.length > 0) {
    console.log(
      `\n⚠️ 恢复流程部分完成：成功恢复 ${executedUpdates.length} 支，失败 ${failedUploads.length} 支：`,
    );
    failedUploads.forEach((f) => {
      console.error(`   - 失败球队: ${f.teamName} (原因: ${f.error})`);
    });
    process.exitCode = 1;
  } else {
    console.log(`\n🎉 恢复流程全部成功完成！共恢复 ${executedUpdates.length} 支球队队徽。`);
  }
}

main()
  .catch((e) => {
    console.error('执行失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
