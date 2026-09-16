import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class CronSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers['authorization'];
    const expected = process.env.CRON_SECRET;

    // 与原逻辑等价：无 CRON_SECRET 或无 authHeader 时拒绝
    if (!expected || !authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ForbiddenException('未授权的定时备份请求');
    }

    const token = authHeader.slice(7);
    const expectedBuf = Buffer.from(expected);
    const tokenBuf = Buffer.from(token);

    // 长度不等时直接拒绝，避免 timingSafeEqual 抛异常
    if (expectedBuf.length !== tokenBuf.length) {
      throw new ForbiddenException('未授权的定时备份请求');
    }
    if (!timingSafeEqual(expectedBuf, tokenBuf)) {
      throw new ForbiddenException('未授权的定时备份请求');
    }
    return true;
  }
}
