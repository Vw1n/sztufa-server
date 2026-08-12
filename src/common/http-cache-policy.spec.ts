import { getApiCacheControl, isPublicCacheableRequest } from './http-cache-policy';

describe('HTTP cache policy', () => {
  it.each([
    '/api/v1/seasons',
    '/api/v1/seasons/active',
    '/api/v1/seasons/season-1/standings',
    '/api/v1/teams',
    '/api/v1/teams/search',
    '/api/v1/teams/team-1/players',
    '/api/v1/players/player-1/career',
    '/api/v1/news/news-1',
  ])('allows shared caching for public GET %s', (path) => {
    expect(isPublicCacheableRequest('GET', path)).toBe(true);
    expect(getApiCacheControl('GET', path)).toContain('public');
  });

  it.each([
    '/api/v1/teams/admin/manage',
    '/api/v1/players/admin/manage',
    '/api/v1/auth/me',
    '/api/v1/backups/list',
    '/api/docs/swagger.json',
  ])('keeps private or operational GET %s out of shared caches', (path) => {
    expect(isPublicCacheableRequest('GET', path)).toBe(false);
    expect(getApiCacheControl('GET', path)).toBe('private, no-store');
  });

  it('never shares mutation responses', () => {
    expect(getApiCacheControl('POST', '/api/v1/news')).toBe('private, no-store');
    expect(getApiCacheControl('PATCH', '/api/v1/matches/match-1')).toBe('private, no-store');
    expect(getApiCacheControl('DELETE', '/api/v1/teams/team-1')).toBe('private, no-store');
  });

  it('uses a shorter cache window for match data', () => {
    expect(getApiCacheControl('GET', '/api/v1/matches')).toBe(
      'public, s-maxage=15, stale-while-revalidate=30',
    );
  });
});
