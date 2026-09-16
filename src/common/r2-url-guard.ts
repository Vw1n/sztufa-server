import { UnprocessableEntityException } from '@nestjs/common';

let cachedAllowedHost: string | null = null;

function getAllowedHost(): string {
  if (cachedAllowedHost) return cachedAllowedHost;
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) throw new Error('R2_PUBLIC_URL 未配置');
  cachedAllowedHost = new URL(publicUrl).host;
  return cachedAllowedHost;
}

/**
 * 校验 URL 是否为 R2 公共桶域名下的 http(s) 资源。
 * 通过则返回原 URL，失败抛 UnprocessableEntityException。
 *
 * 拒绝：javascript:、data:、blob:、非 http(s) 协议、
 *       非白名单 host、携带 userinfo、格式非法。
 */
export function assertPublicAssetUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new UnprocessableEntityException('图片 URL 不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnprocessableEntityException('图片 URL 格式非法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnprocessableEntityException('仅允许 http/https 协议的图片 URL');
  }
  if (parsed.username || parsed.password) {
    throw new UnprocessableEntityException('URL 不允许携带 userinfo');
  }
  if (parsed.host !== getAllowedHost()) {
    throw new UnprocessableEntityException('图片 URL 域名不在白名单内');
  }
  return url;
}
