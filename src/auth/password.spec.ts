import { hashPassword, verifyPassword } from './password';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

describe('Password Utilities', () => {
  it('生成的哈希必须为 scrypt 格式且与明文不同', async () => {
    const raw = 'Password!123';
    const hash = await hashPassword(raw);

    expect(hash).not.toBe(raw);
    expect(hash.startsWith('scrypt$')).toBe(true);

    const parts = hash.split('$');
    expect(parts.length).toBe(3);
    expect(parts[1]).toHaveLength(32); // 16 bytes hex = 32 chars
    expect(parts[2]).toHaveLength(128); // 64 bytes hex = 128 chars
  });

  it('有效密码能成功校验通过，错误密码校验失败', async () => {
    const raw = 'SecurePass_2026';
    const hash = await hashPassword(raw);

    expect(await verifyPassword(raw, hash)).toBe(true);
    expect(await verifyPassword('WrongPassword', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('密码长度边界：小于 6 位拒绝 (400)，6–128 位通过，大于 128 位拒绝 (400)', async () => {
    // 5 位 -> 拒绝
    await expect(hashPassword('12345')).rejects.toThrow(BadRequestException);

    // 6 位 -> 通过
    const hash6 = await hashPassword('123456');
    expect(await verifyPassword('123456', hash6)).toBe(true);

    // 128 位 -> 通过
    const raw128 = 'a'.repeat(128);
    const hash128 = await hashPassword(raw128);
    expect(await verifyPassword(raw128, hash128)).toBe(true);

    // 129 位 -> 拒绝
    const raw129 = 'a'.repeat(129);
    await expect(hashPassword(raw129)).rejects.toThrow(BadRequestException);
    expect(await verifyPassword(raw129, hash128)).toBe(false);
  });

  it('兼容历史 bcrypt 哈希校验', async () => {
    const raw = 'legacyBcryptPass';
    const legacyHash = await bcrypt.hash(raw, 10);

    expect(await verifyPassword(raw, legacyHash)).toBe(true);
    expect(await verifyPassword('wrongPass', legacyHash)).toBe(false);
  });

  it('畸形哈希字符串应安全返回 false 而非崩溃', async () => {
    expect(await verifyPassword('pass', 'scrypt$invalid')).toBe(false);
    expect(await verifyPassword('pass', 'scrypt$$')).toBe(false);
    expect(await verifyPassword('pass', 'invalid_format')).toBe(false);
  });
});
