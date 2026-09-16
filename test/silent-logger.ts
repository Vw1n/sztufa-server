import { LoggerService } from '@nestjs/common';
import { RedactingLogger } from '../src/common/redacting-logger';

/** 测试环境默认 Logger：丢弃所有日志输出 */
export class SilentLogger implements LoggerService {
  log(): void {}
  warn(): void {}
  error(): void {}
  debug?(): void {}
  verbose?(): void {}
  setLogLevels?(): void {}
}

/**
 * 根据环境变量返回测试用 Logger。
 * DEBUG_TEST_LOGS=1 时使用 RedactingLogger（保留脱敏日志），
 * 否则使用 SilentLogger（丢弃所有日志）。
 */
export function getTestLogger(): LoggerService {
  return process.env.DEBUG_TEST_LOGS === '1' ? new RedactingLogger() : new SilentLogger();
}
