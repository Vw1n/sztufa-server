/** Validation cannot prove randomness; deploy independently generated random secrets. */
export function validateJwtSecrets(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  for (const name of ['JWT_SECRET', 'MEMBER_JWT_SECRET']) {
    const value = env[name];
    if (
      !value ||
      value.trim() !== value ||
      Buffer.byteLength(value) < 32 ||
      /\s|change[-_ ]?me|development|dev-secret|super-secret|default-jwt/i.test(value) ||
      new Set(value).size < 12
    ) {
      throw new Error(
        `[FATAL CONFIG ERROR] ${name} 必须配置独立随机密钥（至少 32 字节），禁止示例值`,
      );
    }
  }
  if (env.JWT_SECRET === env.MEMBER_JWT_SECRET) {
    throw new Error('[FATAL CONFIG ERROR] 工作人员与会员 JWT 密钥必须不同');
  }
}
