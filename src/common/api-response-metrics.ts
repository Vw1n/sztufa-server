import type { NextFunction, Request, Response } from 'express';

const DEFAULT_WARNING_THRESHOLD_BYTES = 256 * 1024;

export function getResponseWarningThreshold(): number {
  const configured = Number(process.env.API_RESPONSE_SIZE_WARNING_BYTES);
  if (!Number.isFinite(configured)) return DEFAULT_WARNING_THRESHOLD_BYTES;
  return Math.max(0, configured);
}

export function apiResponseMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const threshold = getResponseWarningThreshold();
    if (threshold === 0) return;

    const contentLength = Number(res.getHeader('Content-Length'));
    if (!Number.isFinite(contentLength) || contentLength < threshold) return;

    console.warn(
      JSON.stringify({
        event: 'large_api_response',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        responseBytes: contentLength,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  next();
}
