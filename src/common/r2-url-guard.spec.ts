import { UnprocessableEntityException } from '@nestjs/common';
import { assertPublicAssetUrl } from './r2-url-guard';

describe('assertPublicAssetUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, R2_PUBLIC_URL: 'https://cdn.example.com/assets/' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('允许合法的 https URL', () => {
    const url = 'https://cdn.example.com/assets/temp/user_x/x.webp';
    expect(assertPublicAssetUrl(url)).toBe(url);
  });

  it('允许合法的 http URL（当白名单 host 匹配时）', () => {
    // 我们的验证目前只看 host 是否等于 R2_PUBLIC_URL 的 host。
    const url = 'http://cdn.example.com/assets/temp/x.webp';
    expect(assertPublicAssetUrl(url)).toBe(url);
  });

  it('拒绝 javascript 协议', () => {
    expect(() => assertPublicAssetUrl('javascript:alert(1)')).toThrow(UnprocessableEntityException);
  });

  it('拒绝 data 协议', () => {
    expect(() => assertPublicAssetUrl('data:text/html,<script>alert(1)</script>')).toThrow(
      UnprocessableEntityException,
    );
  });

  it('拒绝 blob 协议', () => {
    expect(() => assertPublicAssetUrl('blob:https://cdn.example.com/xxx')).toThrow(
      UnprocessableEntityException,
    );
  });

  it('拒绝空串', () => {
    expect(() => assertPublicAssetUrl('')).toThrow(UnprocessableEntityException);
  });

  it('拒绝非白名单 host', () => {
    expect(() => assertPublicAssetUrl('https://evil.com/temp/x.webp')).toThrow(
      UnprocessableEntityException,
    );
  });

  it('拒绝 userinfo 伪造', () => {
    expect(() => assertPublicAssetUrl('https://cdn.example.com@evil.com/temp/x.webp')).toThrow(
      UnprocessableEntityException,
    );
  });

  it('拒绝携带 userinfo 的白名单 host', () => {
    expect(() => assertPublicAssetUrl('https://user:pass@cdn.example.com/temp/x')).toThrow(
      UnprocessableEntityException,
    );
  });

  it('允许大小写 host', () => {
    const url = 'HTTPS://CDN.EXAMPLE.COM/temp/x';
    expect(assertPublicAssetUrl(url)).toBe(url);
  });
});
