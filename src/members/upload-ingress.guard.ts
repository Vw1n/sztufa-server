import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { uploadIngressLimiter } from '../common/concurrency-limiter';

@Injectable()
export class UploadIngressGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    if (req.destroyed || res.writableEnded) {
      throw new ServiceUnavailableException('连接已关闭');
    }

    let isClosed = false;
    let releaseHeldSlot: (() => void) | null = null;
    let receiveDeadline: NodeJS.Timeout | undefined;
    const received = () => { if (receiveDeadline) clearTimeout(receiveDeadline); };

    const closeHandler = () => {
      isClosed = true;
      received();
      if (releaseHeldSlot) {
        releaseHeldSlot();
        releaseHeldSlot = null;
      }
    };

    res.once('finish', closeHandler);
    res.once('close', closeHandler);
    req.once('error', closeHandler);

    // 绝对接收期限，不是可被持续滴流重置的 socket 空闲超时。
    receiveDeadline = setTimeout(() => {
      isClosed = true;
      req.destroy(new ServiceUnavailableException('文件上传接收超时'));
      closeHandler();
    }, 15000);
    receiveDeadline.unref?.();
    req.once('end', received);
    if (req.readableEnded) received();

    try {
      await new Promise<void>((resolve, reject) => {
        uploadIngressLimiter
          .run(async () => {
            // 当从队列唤醒并获得执行槽位时，第一时间检查请求是否在排队期间已关闭
            if (isClosed || req.destroyed || res.writableEnded) {
              reject(new ServiceUnavailableException('连接在排队期间已断开'));
              return; // 立即返回以触发 limiter finally 释放槽位
            }

            resolve();

            // 保持槽位直到请求处理完毕或客户端断连
            await new Promise<void>((held) => {
              releaseHeldSlot = held;
              if (isClosed || req.destroyed || res.writableEnded) {
                held();
              }
            });
          })
          .catch(reject);
      });

      return true;
    } catch (err: any) {
      closeHandler();
      if (err?.status === 503 || err instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException(
          '上传服务连接繁忙或连接已中断，请稍后重试',
        );
      }
      throw err;
    }
  }
}
