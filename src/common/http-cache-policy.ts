import type { Request, Response, NextFunction } from 'express';

const PUBLIC_API_PATTERNS = [
  /^\/api\/v1\/seasons(?:\/[^/]+\/(?:standings|stats|groups)|\/active)?\/?$/,
  /^\/api\/v1\/matches(?:\/[^/]+)?\/?$/,
  /^\/api\/v1\/teams(?:\/search|\/[^/]+(?:\/players)?)?\/?$/,
  /^\/api\/v1\/players(?:\/search|\/[^/]+(?:\/career)?)?\/?$/,
  /^\/api\/v1\/news(?:\/[^/]+)?\/?$/,
  /^\/api\/v1\/public\/summary\/?$/,
] as const;

export function isPublicCacheableRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  if (path.includes('/admin/')) return false;
  return PUBLIC_API_PATTERNS.some((pattern) => pattern.test(path));
}

export function getApiCacheControl(method: string, path: string): string {
  if (!isPublicCacheableRequest(method, path)) return 'private, no-store';

  if (/^\/api\/v1\/matches(?:\/|$)/.test(path)) {
    return 'public, s-maxage=15, stale-while-revalidate=30';
  }

  return 'public, s-maxage=300, stale-while-revalidate=1800';
}

export function apiCachePolicyMiddleware(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', getApiCacheControl(req.method, req.path));
  res.vary('Origin');
  next();
}
