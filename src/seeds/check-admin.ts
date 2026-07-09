import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const adminUser = await prisma.user.findUnique({
    where: { username: 'admin' }
  });
  if (adminUser) {
    console.log('当前 admin 用户角色:', adminUser.role);
    if (adminUser.role !== 'super_admin') {
      await prisma.user.update({
        where: { username: 'admin' },
        data: { role: 'super_admin' }
      });
      console.log('已成功将 admin 用户的角色修改为 super_admin');
    } else {
      console.log('admin 用户已经是 super_admin，无需修改');
    }
  } else {
    console.log('未找到 admin 用户');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
