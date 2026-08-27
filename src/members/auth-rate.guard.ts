import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { consumeRollingLogin } from '../common/rolling-login-limit';

@Injectable()
export class AuthRateGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    // 使用匹配到的路由模板，避免大小写、尾斜杠、兼容别名拆分配额。
    const path = String(req.route?.path || req.path)
      .toLowerCase()
      .replace(/\/+$/, '')
      .replace('/api/v1/auth/', '/api/v1/staff-auth/');
    const login = path.endsWith('/login');
    const windowMs = 10 * 60 * 1000;
    const slot = Math.floor(Date.now() / windowMs);
    // req.ip 只在部署方配置可信代理后才接受转发 IP，不能直接信任任意 X-Forwarded-For。
    const keys: [string, number][] = [[`ip:${req.ip}`, login ? 100 : 30]];
    if (login && typeof req.body?.username === 'string') {
      keys.push([`account:${req.body.username.trim().slice(0, 128)}`, 10]);
    }
    for (const [key, limit] of keys) {
      const id = createHash('sha256').update(`${path}:${slot}:${key}`).digest('hex');
      const record = await this.prisma.authRateLimit.upsert({
        where: { id },
        create: { id, count: 1, expiresAt: new Date((slot + 1) * windowMs) },
        update: { count: { increment: 1 } },
      });
      if (record.count > limit) throw new HttpException('操作过于频繁，请稍后重试', 429);
      if (login && !(await consumeRollingLogin(this.prisma, path, key, limit))) {
        throw new HttpException('操作过于频繁，请稍后重试', 429);
      }
    }
    return true;
  }
}
