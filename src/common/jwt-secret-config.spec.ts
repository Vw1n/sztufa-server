import { validateJwtSecrets } from './jwt-secret-config';

describe('production JWT configuration', () => {
  const valid = {
    NODE_ENV: 'production',
    JWT_SECRET: '0123456789abcdefABCDEF_0123456789xy',
    MEMBER_JWT_SECRET: 'abcdefghijklmnopQRSTUV_9876543210xy',
  };
  it('accepts separate sufficiently long secrets', () =>
    expect(() => validateJwtSecrets(valid)).not.toThrow());
  it.each([
    undefined,
    '',
    'short',
    'local-development-secret-change-me',
    'x'.repeat(64),
    ' '.repeat(32),
  ])('rejects unsafe secrets: %s', (value) => {
    for (const name of ['JWT_SECRET', 'MEMBER_JWT_SECRET']) {
      expect(() => validateJwtSecrets({ ...valid, [name]: value })).toThrow(name);
    }
  });
  it('rejects shared secrets', () =>
    expect(() => validateJwtSecrets({ ...valid, MEMBER_JWT_SECRET: valid.JWT_SECRET })).toThrow());
  it('does not change local development defaults', () =>
    expect(() => validateJwtSecrets({ NODE_ENV: 'test' })).not.toThrow());
});
