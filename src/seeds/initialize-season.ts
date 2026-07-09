import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('开始初始化赛季数据...');

  // 1. 查找或创建活跃赛季
  let activeSeason = await prisma.season.findFirst({
    where: { status: 'active' },
  });

  if (!activeSeason) {
    activeSeason = await prisma.season.create({
      data: {
        name: '2026春季赛季',
        status: 'active',
      },
    });
    console.log(`已创建默认活跃赛季: ${activeSeason.name} (${activeSeason.id})`);
  } else {
    console.log(`已存在活跃赛季: ${activeSeason.name} (${activeSeason.id})`);
  }

  // 2. 将所有未归属的比赛绑定到当前活跃赛季
  const matchesToUpdate = await prisma.match.findMany({
    where: { seasonId: null },
  });

  if (matchesToUpdate.length > 0) {
    console.log(
      `发现 ${matchesToUpdate.length} 场未绑定赛季的比赛，正在绑定到 ${activeSeason.name}...`,
    );
    const updateResult = await prisma.match.updateMany({
      where: { seasonId: null },
      data: {
        seasonId: activeSeason.id,
      },
    });
    console.log(`绑定完成，共更新了 ${updateResult.count} 场比赛。`);
  } else {
    console.log('所有比赛已绑定赛季，无需更新。');
  }

  console.log('赛季初始化脚本执行成功！');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
