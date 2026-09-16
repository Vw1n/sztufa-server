import { Logger } from '@nestjs/common';

const logger = new Logger('EnvConfig');

/**
 * 解析正整数环境变量。
 *
 * 非法输入全部回退 fallback，保证返回值始终是 >= 1 的安全整数。
 * 拒绝：undefined、空串、空白、非数字、零、负数、小数、科学计数法、
 *       带正负号、前导零、超安全整数范围。
 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  configKey?: string,
): number {
  if (!raw || raw.trim() === '') return fallback;
  // 仅允许纯十进制数字（1-9 开头，后续 0-9），拒绝小数、科学计数法、正负号、前导零
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    if (configKey) {
      logger.warn(`配置 ${configKey} 的值 "${raw}" 不合法，已回退为默认值 ${fallback}`);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    if (configKey) {
      logger.warn(`配置 ${configKey} 的值 "${raw}" 不合法或超出范围，已回退为默认值 ${fallback}`);
    }
    return fallback;
  }
  return n;
}
