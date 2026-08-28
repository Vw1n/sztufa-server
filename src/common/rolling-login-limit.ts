import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export const loginLimitPrefix = (path: string, key: string) =>
  `rolling:${createHash('sha256').update(`${path}:${key}`).digest('hex')}:`;

/** PostgreSQL row lock serializes each key across processes; no schema change needed. */
export async function consumeRollingLogin(
  prisma: PrismaService,
  path: string,
  key: string,
  limit: number,
) {
  const prefix = loginLimitPrefix(path, key);
  return prisma.$transaction(async (tx) => {
    await tx.authRateLimit.upsert({
      where: { id: `${prefix}lock` },
      create: { id: `${prefix}lock`, count: 1, expiresAt: new Date(Date.now() + 1200_000) },
      update: { count: { increment: 1 }, expiresAt: new Date(Date.now() + 1200_000) },
    });
    const now = new Date(Date.now());
    const events = { id: { startsWith: `${prefix}event:` } };
    await tx.authRateLimit.deleteMany({ where: { ...events, expiresAt: { lte: now } } });
    const used = await tx.authRateLimit.count({ where: { ...events, expiresAt: { gt: now } } });
    if (used >= limit) return false;
    await tx.authRateLimit.create({
      data: {
        id: `${prefix}event:${randomUUID()}`,
        count: 1,
        expiresAt: new Date(+now + 600_000),
      },
    });
    return true;
  });
}
