import { BoundedConcurrencyLimiter } from './concurrency-limiter';
import { HttpException } from '@nestjs/common';

describe('BoundedConcurrencyLimiter', () => {
  it('应该在并发限制内正常执行任务', async () => {
    const limiter = new BoundedConcurrencyLimiter(2, 4, 1000);
    const results = await Promise.all([
      limiter.run(async () => 'task1'),
      limiter.run(async () => 'task2'),
    ]);
    expect(results).toEqual(['task1', 'task2']);
  });

  it('超过并发与等待队列上限时应立即抛出 503 异常拒绝请求', async () => {
    const limiter = new BoundedConcurrencyLimiter(2, 2, 1000);
    let releaseHold: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    // 运行 2 个占用并发槽
    const p1 = limiter.run(() => holdPromise);
    const p2 = limiter.run(() => holdPromise);

    // 2 个进入等待队列
    const p3 = limiter.run(() => holdPromise);
    const p4 = limiter.run(() => holdPromise);

    expect(limiter.stats.running).toBe(2);
    expect(limiter.stats.queued).toBe(2);

    // 第 5 个任务（超出 2 执行 + 2 队列）应立即被 503 拒绝
    await expect(limiter.run(async () => 'task5')).rejects.toThrow(HttpException);
    await expect(limiter.run(async () => 'task5')).rejects.toMatchObject({
      status: 503,
    });

    releaseHold!();
    await Promise.all([p1, p2, p3, p4]);
    expect(limiter.stats.running).toBe(0);
    expect(limiter.stats.queued).toBe(0);
  });

  it('Scrypt 限制器应在第 21 个任务全忙时拒绝 (4 执行 + 16 队列)', async () => {
    const limiter = new BoundedConcurrencyLimiter(4, 16, 2000);
    let releaseAll: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const tasks: Promise<any>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(limiter.run(() => hold));
    }

    expect(limiter.stats.running).toBe(4);
    expect(limiter.stats.queued).toBe(16);

    // 第 21 个任务
    await expect(limiter.run(async () => 'task21')).rejects.toMatchObject({
      status: 503,
    });

    releaseAll!();
    await Promise.all(tasks);
    expect(limiter.stats.running).toBe(0);
  });

  it('Sharp 限制器应在第 11 个任务全忙时拒绝 (2 执行 + 8 队列)', async () => {
    const limiter = new BoundedConcurrencyLimiter(2, 8, 2000);
    let releaseAll: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const tasks: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(limiter.run(() => hold));
    }

    expect(limiter.stats.running).toBe(2);
    expect(limiter.stats.queued).toBe(8);

    // 第 11 个任务
    await expect(limiter.run(async () => 'task11')).rejects.toMatchObject({
      status: 503,
    });

    releaseAll!();
    await Promise.all(tasks);
    expect(limiter.stats.running).toBe(0);
  });

  it('任务发生异常时必须在 finally 中安全释放槽位', async () => {
    const limiter = new BoundedConcurrencyLimiter(1, 2, 1000);

    await expect(
      limiter.run(async () => {
        throw new Error('计算异常');
      }),
    ).rejects.toThrow('计算异常');

    expect(limiter.stats.running).toBe(0);
    expect(limiter.stats.queued).toBe(0);

    // 后续任务仍能正常执行
    const result = await limiter.run(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('排队超过超时时间后应抛出 503 并移除出队列', async () => {
    const limiter = new BoundedConcurrencyLimiter(1, 2, 50); // 50ms 超时
    let releaseHold: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const p1 = limiter.run(() => hold);
    const p2 = limiter.run(async () => 'timed_out_task');

    await expect(p2).rejects.toMatchObject({ status: 503 });
    expect(limiter.stats.queued).toBe(0);

    releaseHold!();
    await p1;
  });
});
