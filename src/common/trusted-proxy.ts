import { isIP } from 'net';

export function trustedProxyConfig(env: NodeJS.ProcessEnv = process.env): false | string[] {
  const configured = env.TRUST_PROXY?.trim();
  if (!configured) {
    if (env.NODE_ENV === 'production') {
      throw new Error('生产环境必须显式配置 TRUST_PROXY 为受控代理 IP/CIDR 或 none');
    }
    return false;
  }
  if (configured === 'none') return false;
  const entries = configured.split(',').map((value) => value.trim());
  for (const value of entries) {
    const [ip, prefix, extra] = value.split('/');
    const version = isIP(ip);
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('TRUST_PROXY 只能包含受控代理 IP/CIDR；禁止宽泛命名网段与 /0');
    }
  }
  return entries;
}
