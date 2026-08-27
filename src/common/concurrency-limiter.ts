import { HttpException } from '@nestjs/common';

export class BoundedConcurrencyLimiter {
  private running = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
    private readonly timeoutMs: number = 5000,
  ) {}

  get stats() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        throw new HttpException('服务计算资源繁忙，请稍后重试', 503);
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.queue.findIndex((item) => item.timer === timer);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(new HttpException('计算任务排队超时，请稍后重试', 503));
        }, this.timeoutMs);

        this.queue.push({ resolve, reject, timer });
      });
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve();
        }
      }
    }
  }
}

// 进程全局共享单例
export const scryptLimiter = new BoundedConcurrencyLimiter(4, 16, 5000);
export const sharpLimiter = new BoundedConcurrencyLimiter(2, 8, 5000);
export const uploadIngressLimiter = new BoundedConcurrencyLimiter(6, 12, 15000);
