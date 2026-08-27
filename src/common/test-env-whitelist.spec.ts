import { assertSafeTestEnvironment } from './test-env-whitelist';

describe('测试环境严格白名单', () => {
  const safe = { databaseUrl: 'postgresql://test:test@127.0.0.1:5432/sztufa_member_test',
    storageEndpoint: 'http://127.0.0.1:9000', bucketName: 'sztufa-member-test-cards' };
  it('仅明确的隔离配置通过', () => { expect(() => assertSafeTestEnvironment(safe)).not.toThrow(); });
  it.each([
    { databaseUrl: '' }, { storageEndpoint: '' }, { bucketName: '' },
    { databaseUrl: 'postgresql://test:test@127.0.0.1:5432/postgres' },
    { databaseUrl: 'postgresql://test:test@remote.example:5432/sztufa_member_test' },
    { storageEndpoint: 'https://account.r2.cloudflarestorage.com' },
    { storageEndpoint: 'http://127.0.0.1:9000/unexpected' },
    { bucketName: 'sztufa-private-cards' },
  ])('拒绝非测试目标或缺失配置 %#', (override) => {
    expect(() => assertSafeTestEnvironment({ ...safe, ...override })).toThrow();
  });
});
