import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('正在查询数据库球队...');
  const teams = await prisma.team.findMany();
  if (teams.length === 0) {
    console.error('数据库中没有任何球队，请先在管理后台录入一队球队以便教练绑定！');
    return;
  }
  
  const team = teams[0];
  console.log(`找到首个球队: ${team.teamName} (ID: ${team.id})`);

  const saltRounds = 10;
  const scorerPasswordHash = await bcrypt.hash('scorer123', saltRounds);
  const coachPasswordHash = await bcrypt.hash('coach123', saltRounds);

  // 1. 创建或覆盖更新 赛事记录员
  await prisma.user.upsert({
    where: { username: 'scorer' },
    update: {
      password: scorerPasswordHash,
      role: 'match_scorer',
      teamId: null,
    },
    create: {
      username: 'scorer',
      password: scorerPasswordHash,
      role: 'match_scorer',
      teamId: null,
    },
  });
  console.log('赛事记录员账号创建/更新成功: scorer / scorer123');

  // 2. 创建或覆盖更新 教练
  await prisma.user.upsert({
    where: { username: 'coach' },
    update: {
      password: coachPasswordHash,
      role: 'coach',
      teamId: team.id,
    },
    create: {
      username: 'coach',
      password: coachPasswordHash,
      role: 'coach',
      teamId: team.id,
    },
  });
  console.log(`教练/领队账号创建/更新成功: coach / coach123 (已绑定球队: ${team.teamName})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
