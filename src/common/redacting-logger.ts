import { ConsoleLogger, LoggerService } from '@nestjs/common';

export function redactLog(value: unknown): string {
  let text: string;
  try { text = value instanceof Error ? value.stack || value.message :
    typeof value === 'string' ? value : JSON.stringify(value); }
  catch { return '[UNSERIALIZABLE]'; }
  text = text ?? '';
  for (const [key, secret] of Object.entries(process.env)) {
    if (/password|token|secret|credential|database_url|direct_url|access.?key/i.test(key) && secret && secret.length >= 4) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s<>"']+/gi, '[REDACTED_CONNECTION]')
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/(["']?(?:password|passwd|token|access_token|refresh_token|authorization|cookie|secret|accessKeyId|secretAccessKey)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/\b(\d{2})\d{4,16}(\d{2})\b/g, '$1****$2');
}

export class RedactingLogger implements LoggerService {
  private readonly logger = new ConsoleLogger({ logLevels: ['log', 'warn', 'error'] });
  log(message: unknown, ...args: unknown[]) { this.logger.log(redactLog(message), ...args.map(redactLog)); }
  warn(message: unknown, ...args: unknown[]) { this.logger.warn(redactLog(message), ...args.map(redactLog)); }
  error(message: unknown, ...args: unknown[]) { this.logger.error(redactLog(message), ...args.map(redactLog)); }
}
