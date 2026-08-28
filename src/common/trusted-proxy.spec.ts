import express from 'express';
import request from 'supertest';
import { trustedProxyConfig } from './trusted-proxy';

describe('真实 Express 转发头解析', () => {
  it('未受信代理不能通过转发头伪造 req.ip', async () => {
    const app = express();
    app.set('trust proxy', trustedProxyConfig({ TRUST_PROXY: 'none' }));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const a = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/').set('X-Forwarded-For', '203.0.113.2');
    expect(a.body.ip).toBe(b.body.ip);
    expect(a.body.ip).not.toBe('203.0.113.1');
  });
  it('只有明确配置的代理才解析客户端转发地址', async () => {
    const app = express();
    app.set('trust proxy', trustedProxyConfig({ TRUST_PROXY: '127.0.0.1/32,::1/128' }));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const response = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1');
    expect(response.body.ip).toBe('203.0.113.1');
  });
  it('生产缺少配置、宽泛网段与 /0 均拒绝启动', () => {
    expect(() => trustedProxyConfig({ NODE_ENV: 'production' })).toThrow();
    for (const setting of ['true', 'uniquelocal', '0.0.0.0/0', '::/0']) {
      expect(() => trustedProxyConfig({ TRUST_PROXY: setting })).toThrow();
    }
  });
});
