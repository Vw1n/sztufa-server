// 只读预检。显式提供 ACCOUNT_MIGRATION_AUDIT_URL；不自动读取生产 .env。
import { PrismaClient } from '@prisma/client';
const url = process.env.ACCOUNT_MIGRATION_AUDIT_URL;
if (!url) throw new Error('请显式设置 ACCOUNT_MIGRATION_AUDIT_URL（建议只读数据库账号）');
const prisma = new PrismaClient({ datasources: { db: { url } } });
async function main() {
  const roles = await prisma.$queryRaw<
    Array<{ role: string; count: bigint }>
  >`SELECT role, COUNT(*) FROM "User" GROUP BY role`;
  const staffPredictions = await prisma.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT COUNT(*) FROM "Prediction" p JOIN "User" u ON u.id=p."userId" WHERE u.role <> 'user'`;
  const memberStaffLinks = await prisma.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT COUNT(*) FROM "User" u WHERE u.role='user' AND (u."teamId" IS NOT NULL OR EXISTS (SELECT 1 FROM "SeasonDeletionApproval" a WHERE a."approverId"=u.id) OR EXISTS (SELECT 1 FROM "TeamRegistration" r WHERE r."submittedById"=u.id OR r."reviewedById"=u.id))`;
  console.log(
    JSON.stringify(
      {
        roles,
        staffPredictions: staffPredictions[0].count,
        memberStaffLinks: memberStaffLinks[0].count,
      },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
  if (staffPredictions[0].count || memberStaffLinks[0].count)
    throw new Error('存在跨类型历史关联，必须先人工核实，迁移会安全中止');
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
