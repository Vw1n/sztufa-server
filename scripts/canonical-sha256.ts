import * as crypto from 'crypto';

export function canonicalStringify(obj: any): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'number' || typeof obj === 'boolean') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'bigint') return JSON.stringify(obj.toString());
  if (obj instanceof Date) return JSON.stringify(obj.toISOString());

  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalStringify(item));
    return '[' + items.join(',') + ']';
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`);
    return '{' + pairs.join(',') + '}';
  }

  return JSON.stringify(String(obj));
}

export function computeCanonicalHash(obj: any): string {
  const json = canonicalStringify(obj);
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}
