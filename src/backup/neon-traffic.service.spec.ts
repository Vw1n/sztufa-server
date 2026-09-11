import { NeonTrafficService, NEON_FREE_ALLOWANCE_BYTES } from './neon-traffic.service';

describe('NeonTrafficService', () => {
  let service: NeonTrafficService;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    service = new NeonTrafficService();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('未配置 NEON_API_KEY 或 NEON_PROJECT_ID 时，返回 not_configured 且绝不抛错', async () => {
    delete process.env.NEON_API_KEY;
    delete process.env.NEON_PROJECT_ID;

    const res = await service.fetchMonthlyTraffic();

    expect(res.status).toBe('not_configured');
    expect(res.dataTransferBytes).toBeNull();
    expect(res.allowanceBytes).toBe(NEON_FREE_ALLOWANCE_BYTES);
    expect(res.alertLevel).toBe('unknown');
    expect(res.stale).toBe(false);
  });

  it('配置有效且返回成功数据时，正确解析字节并标记 normal 告警', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    const mockDataTransfer = 1024 * 1024 * 1024; // 1 GB
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        project: {
          consumption: {
            data_transfer_bytes: mockDataTransfer,
            period_start: '2026-09-01T00:00:00Z',
            period_end: '2026-10-01T00:00:00Z',
          },
        },
      }),
    } as any);

    const res = await service.fetchMonthlyTraffic();

    expect(res.status).toBe('active');
    expect(res.dataTransferBytes).toBe(mockDataTransfer);
    expect(res.allowanceUsedPercent).toBe(20);
    expect(res.alertLevel).toBe('normal');
    expect(res.stale).toBe(false);
    expect(res.billingPeriod).toBe('2026-09-01T00:00:00Z - 2026-10-01T00:00:00Z');
    expect(res.billingStart).toBe('2026-09-01T00:00:00Z');
    expect(res.billingEnd).toBe('2026-10-01T00:00:00Z');
  });

  it('当流量达到 3.5GB 时标记 yellow 预警，达到 4GB 时标记 red 告警', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    // 3.6 GB
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        project: {
          data_transfer_bytes: 3.6 * 1024 * 1024 * 1024,
        },
      }),
    } as any);

    const yellowRes = await service.fetchMonthlyTraffic(true);
    expect(yellowRes.alertLevel).toBe('yellow');

    // 4.2 GB
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        project: {
          data_transfer_bytes: 4.2 * 1024 * 1024 * 1024,
        },
      }),
    } as any);

    const redRes = await service.fetchMonthlyTraffic(true);
    expect(redRes.alertLevel).toBe('red');
  });

  it('在缓存期内多次调用，直接复用内存缓存且不发起额外 fetch 请求', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        project: { data_transfer_bytes: 1000 },
      }),
    });
    global.fetch = fetchMock as any;

    await service.fetchMonthlyTraffic();
    await service.fetchMonthlyTraffic();
    await service.fetchMonthlyTraffic();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('并发多次调用自动合并为单个在途请求 (In-flight Promise deduplication)', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    let resolvePromise: any;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const fetchMock = jest.fn().mockImplementation(() => pendingPromise);
    global.fetch = fetchMock as any;

    const p1 = service.fetchMonthlyTraffic(true);
    const p2 = service.fetchMonthlyTraffic(true);
    const p3 = service.fetchMonthlyTraffic(true);

    resolvePromise({
      ok: true,
      json: () => Promise.resolve({ project: { data_transfer_bytes: 500 } }),
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.dataTransferBytes).toBe(500);
    expect(r2.dataTransferBytes).toBe(500);
    expect(r3.dataTransferBytes).toBe(500);
  });

  it('当 API 报错 500 时，优雅降级返回 unavailable 且不抛出未捕获异常', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as any);

    const res = await service.fetchMonthlyTraffic(true);

    expect(res.status).toBe('unavailable');
    expect(res.dataTransferBytes).toBeNull();
    expect(res.stale).toBe(true);
  });

  it('当网络超时抛出 AbortError 时，优雅降级为 unavailable', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortError);

    const res = await service.fetchMonthlyTraffic(true);

    expect(res.status).toBe('unavailable');
    expect(res.message).toContain('超时');
  });

  it('若存在历史缓存且后续请求失败，返回历史缓存并标记 stale=true', async () => {
    process.env.NEON_API_KEY = 'mock-neon-key';
    process.env.NEON_PROJECT_ID = 'mock-project-1';

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        project: { data_transfer_bytes: 8888 },
      }),
    } as any);

    const firstRes = await service.fetchMonthlyTraffic();
    expect(firstRes.status).toBe('active');
    expect(firstRes.dataTransferBytes).toBe(8888);

    // 模拟后续请求失败
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network disconnected'));

    const secondRes = await service.fetchMonthlyTraffic(true);
    expect(secondRes.status).toBe('active');
    expect(secondRes.dataTransferBytes).toBe(8888);
    expect(secondRes.stale).toBe(true);
  });

  describe('isCurrentBillingPeriod 机器账期判断', () => {
    it('当当前时间落在 [billingStart, billingEnd) 区间内时，返回 true（包括天然跨月账期）', () => {
      const activeResult: any = {
        status: 'active',
        billingStart: '2026-09-01T00:00:00Z',
        billingEnd: '2026-10-01T00:00:00Z',
      };
      // 9月15日，处于账期内
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-09-15T12:00:00Z'))).toBe(
        true,
      );
      // 9月1日0点精确边界，处于账期内
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-09-01T00:00:00Z'))).toBe(
        true,
      );
      // 9月30日23:59:59，处于账期内
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-09-30T23:59:59Z'))).toBe(
        true,
      );
    });

    it('当当前时间早于 billingStart 或晚于等于 billingEnd 时，返回 false', () => {
      const activeResult: any = {
        status: 'active',
        billingStart: '2026-09-01T00:00:00Z',
        billingEnd: '2026-10-01T00:00:00Z',
      };
      // 早于起始时间（8月31日）
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-08-31T23:59:59Z'))).toBe(
        false,
      );
      // 达到或超过结束时间（10月1日）
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-10-01T00:00:00Z'))).toBe(
        false,
      );
      expect(service.isCurrentBillingPeriod(activeResult, new Date('2026-10-05T00:00:00Z'))).toBe(
        false,
      );
    });

    it('当未提供 billingStart/End 时，根据 capturedAt 与当前自然月比对', () => {
      const fallbackResult: any = {
        status: 'active',
        billingStart: null,
        billingEnd: null,
        capturedAt: '2026-09-10T15:00:00Z',
      };
      // 同月
      expect(service.isCurrentBillingPeriod(fallbackResult, new Date('2026-09-20T10:00:00Z'))).toBe(
        true,
      );
      // 跨月（10月）
      expect(service.isCurrentBillingPeriod(fallbackResult, new Date('2026-10-01T10:00:00Z'))).toBe(
        false,
      );
    });

    it('当 status 不为 active 时，始终返回 false', () => {
      expect(
        service.isCurrentBillingPeriod({
          status: 'not_configured',
          billingStart: '2026-09-01T00:00:00Z',
          billingEnd: '2026-10-01T00:00:00Z',
        } as any),
      ).toBe(false);
      expect(
        service.isCurrentBillingPeriod({
          status: 'unavailable',
          billingStart: '2026-09-01T00:00:00Z',
          billingEnd: '2026-10-01T00:00:00Z',
        } as any),
      ).toBe(false);
    });
  });
});
