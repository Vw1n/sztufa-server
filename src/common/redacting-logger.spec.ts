import { redactLog } from './redacting-logger';

describe('日志脱敏', () => {
  it('隐藏结构化密码、Token、连接串与完整学号', () => {
    const output = redactLog({ password: 'test secret', token: 'abc-secret', studentId: '2026123456',
      error: 'postgresql://user:pass@localhost:5432/test' });
    for (const secret of ['test secret', 'abc-secret', '2026123456', 'user:pass']) {
      expect(output).not.toContain(secret);
    }
  });
  it('隐藏异常中的 Bearer 凭据并保持诊断信息', () => {
    const output = redactLog(new Error('request failed Authorization: Bearer abcdef-secret'));
    expect(output).not.toContain('abcdef-secret');
    expect(output).toContain('request failed');
  });
});
