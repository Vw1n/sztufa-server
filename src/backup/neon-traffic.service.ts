import { Injectable, Logger } from '@nestjs/common';

export interface NeonTrafficResult {
  status: 'active' | 'not_configured' | 'unavailable';
  capturedAt: string | null;
  billingPeriod: string | null;
  dataTransferBytes: number | null;
  allowanceBytes: number;
  allowanceUsedPercent: number | null;
  alertLevel: 'normal' | 'yellow' | 'red' | 'unknown';
  stale: boolean;
  message?: string;
}

export const NEON_FREE_ALLOWANCE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const NEON_YELLOW_ALERT_BYTES = 3.5 * 1024 * 1024 * 1024; // 3.5 GB (70%)
export const NEON_RED_ALERT_BYTES = 4.0 * 1024 * 1024 * 1024; // 4.0 GB (80%)
export const NEON_CACHE_TTL_MS = 3600000; // 1 小时单实例内存缓存
export const NEON_REQUEST_TIMEOUT_MS = 5000; // 5 秒超时熔断

@Injectable()
export class NeonTrafficService {
  private readonly logger = new Logger(NeonTrafficService.name);
  private cache: { result: NeonTrafficResult; expiresAt: number } | null = null;
  private inFlight: Promise<NeonTrafficResult> | null = null;

  async fetchMonthlyTraffic(forceRefresh = false): Promise<NeonTrafficResult> {
    const apiKey = process.env.NEON_API_KEY;
    const projectId = process.env.NEON_PROJECT_ID;

    if (!apiKey || !projectId) {
      return {
        status: 'not_configured',
        capturedAt: null,
        billingPeriod: null,
        dataTransferBytes: null,
        allowanceBytes: NEON_FREE_ALLOWANCE_BYTES,
        allowanceUsedPercent: null,
        alertLevel: 'unknown',
        stale: false,
        message: 'Neon 官方用量未配置（需配置 NEON_API_KEY 与 NEON_PROJECT_ID）',
      };
    }

    const now = Date.now();
    if (!forceRefresh && this.cache && this.cache.expiresAt > now) {
      return this.cache.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.executeFetch(apiKey, projectId)
      .then((result) => {
        if (result.status === 'active') {
          this.cache = {
            result,
            expiresAt: Date.now() + NEON_CACHE_TTL_MS,
          };
        }
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async executeFetch(apiKey: string, projectId: string): Promise<NeonTrafficResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEON_REQUEST_TIMEOUT_MS);

    try {
      const url = `https://console.neon.tech/api/v2/projects/${projectId}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`Neon API 返回非成功状态码: ${response.status} ${response.statusText}`);
        return this.buildFallbackResult('Neon 官方接口返回异常状态');
      }

      const body = await response.json();
      const project = body?.project || body;

      // 提取 data_transfer_bytes
      const dataTransferBytes =
        typeof project?.consumption?.data_transfer_bytes === 'number'
          ? project.consumption.data_transfer_bytes
          : typeof project?.data_transfer_bytes === 'number'
            ? project.data_transfer_bytes
            : null;

      if (dataTransferBytes === null) {
        return this.buildFallbackResult('Neon 响应中未包含有效的 data_transfer_bytes 指标');
      }

      const allowanceUsedPercent = Number(
        ((dataTransferBytes / NEON_FREE_ALLOWANCE_BYTES) * 100).toFixed(2),
      );

      let alertLevel: 'normal' | 'yellow' | 'red' = 'normal';
      if (dataTransferBytes >= NEON_RED_ALERT_BYTES) {
        alertLevel = 'red';
      } else if (dataTransferBytes >= NEON_YELLOW_ALERT_BYTES) {
        alertLevel = 'yellow';
      }

      const billingStart =
        project?.consumption_period_start || project?.consumption?.period_start || null;
      const billingEnd =
        project?.consumption_period_end || project?.consumption?.period_end || null;
      const billingPeriod =
        billingStart && billingEnd ? `${billingStart} - ${billingEnd}` : '当前官方计费周期';

      return {
        status: 'active',
        capturedAt: new Date().toISOString(),
        billingPeriod,
        dataTransferBytes,
        allowanceBytes: NEON_FREE_ALLOWANCE_BYTES,
        allowanceUsedPercent,
        alertLevel,
        stale: false,
      };
    } catch (err: any) {
      this.logger.warn(`Neon 官方用量采集失败: ${err.message}`);
      return this.buildFallbackResult(
        err.name === 'AbortError' ? 'Neon 官方接口请求超时 (5s)' : 'Neon 官方接口网络请求失败',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private buildFallbackResult(reason: string): NeonTrafficResult {
    if (this.cache) {
      return {
        ...this.cache.result,
        stale: true,
        message: `${reason}，使用历史缓存数据`,
      };
    }
    return {
      status: 'unavailable',
      capturedAt: null,
      billingPeriod: null,
      dataTransferBytes: null,
      allowanceBytes: NEON_FREE_ALLOWANCE_BYTES,
      allowanceUsedPercent: null,
      alertLevel: 'unknown',
      stale: true,
      message: `${reason}，官方用量不可用`,
    };
  }
}
