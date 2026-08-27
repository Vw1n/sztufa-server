import { BadRequestException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { scryptLimiter } from '../common/concurrency-limiter';

const derive = (password: string, salt: string) =>
  scryptLimiter.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          64,
          { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
  );

export async function hashPassword(password: string) {
  if (password.length < 6 || password.length > 128) {
    throw new BadRequestException('密码长度需为 6–128 个字符');
  }
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string) {
  if (password.length > 128) return false;
  if (!hash.startsWith('scrypt$')) {
    return scryptLimiter.run(() => bcrypt.compare(password, hash));
  }
  const [, salt, encoded] = hash.split('$');
  if (!salt || !/^[a-f0-9]{128}$/.test(encoded || '')) return false;
  const derivedKey = await derive(password, salt);
  return timingSafeEqual(derivedKey, Buffer.from(encoded, 'hex'));
}
