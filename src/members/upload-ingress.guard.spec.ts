import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { UploadIngressGuard } from './upload-ingress.guard';
import { uploadIngressLimiter } from '../common/concurrency-limiter';

describe('UploadIngressGuard', () => {
  let guard: UploadIngressGuard;

  beforeEach(() => {
    guard = new UploadIngressGuard();
  });

  it('持续滴流也不能延长 15 秒绝对接收期限', async () => {
    jest.useFakeTimers();
    const req = Object.assign(new EventEmitter(), { destroyed: false, destroy: jest.fn() });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as ExecutionContext;
    try {
      await guard.canActivate(ctx);
      for (let i = 0; i < 15; i++) { req.emit('data', Buffer.from('x')); await jest.advanceTimersByTimeAsync(1000); }
      expect(req.destroy).toHaveBeenCalledTimes(1);
      expect(uploadIngressLimiter.stats.running).toBe(0);
    } finally { res.emit('close'); jest.useRealTimers(); }
  });

  it('正常上传流程：完成请求后应正确释放并发槽位', async () => {
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      setTimeout: jest.fn(),
    });
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
    });
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as ExecutionContext;

    const initialRunning = uploadIngressLimiter.stats.running;

    const canActivatePromise = guard.canActivate(ctx);
    const allowed = await canActivatePromise;
    expect(allowed).toBe(true);
    expect(uploadIngressLimiter.stats.running).toBe(initialRunning + 1);

    // 模拟请求完成
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 10));
    expect(uploadIngressLimiter.stats.running).toBe(initialRunning);
  });

  it('请求排队期间客户端提前断开连接：获得槽位后必须立即安全释放，不得泄露名额', async () => {
    const initialRunning = uploadIngressLimiter.stats.running;

    // 占满最大 6 个并发连接
    const releaseFns: Array<() => void> = [];
    const holdContexts: ExecutionContext[] = [];

    for (let i = 0; i < uploadIngressLimiter.stats.maxConcurrent; i++) {
      const rReq = Object.assign(new EventEmitter(), {
        destroyed: false,
        setTimeout: jest.fn(),
      });
      const rRes = Object.assign(new EventEmitter(), {
        writableEnded: false,
      });
      const rCtx = {
        switchToHttp: () => ({
          getRequest: () => rReq,
          getResponse: () => rRes,
        }),
      } as ExecutionContext;

      holdContexts.push(rCtx);
      guard.canActivate(rCtx);
      releaseFns.push(() => rRes.emit('finish'));
    }

    expect(uploadIngressLimiter.stats.running).toBe(6);

    // 发起第 7 个请求，进入排队队列
    const queuedReq = Object.assign(new EventEmitter(), {
      destroyed: false,
      setTimeout: jest.fn(),
    });
    const queuedRes = Object.assign(new EventEmitter(), {
      writableEnded: false,
    });
    const queuedCtx = {
      switchToHttp: () => ({
        getRequest: () => queuedReq,
        getResponse: () => queuedRes,
      }),
    } as ExecutionContext;

    const queuedPromise = guard.canActivate(queuedCtx);
    expect(uploadIngressLimiter.stats.queued).toBe(1);

    // 模拟排队中的客户端突然断开网络连接 (触发 close 事件)
    queuedRes.emit('close');

    // 释放前置的 6 个占用连接
    for (const release of releaseFns) {
      release();
    }

    // 排队的请求应该被拒绝并捕获 503/异常，且 running 必须全部归零
    await expect(queuedPromise).rejects.toThrow(ServiceUnavailableException);

    // 等待微任务循环结束
    await new Promise((r) => setTimeout(r, 10));

    expect(uploadIngressLimiter.stats.running).toBe(initialRunning);
    expect(uploadIngressLimiter.stats.queued).toBe(0);
  });
});
