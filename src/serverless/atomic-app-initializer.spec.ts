import { createAtomicAppInitializer } from './atomic-app-initializer';

describe('createAtomicAppInitializer', () => {
  it('初始化失败后丢弃半成品服务并用全新实例重试', async () => {
    const servers: Array<{ routes: string[] }> = [];
    let attempt = 0;
    const createApp = createAtomicAppInitializer(
      () => {
        const server = { routes: [] as string[] };
        servers.push(server);
        return server;
      },
      async (server) => {
        attempt++;
        server.routes.push(attempt === 1 ? 'broken-route' : 'ready-route');
        if (attempt === 1) throw new Error('首次初始化失败');
        return { ready: true };
      },
    );

    await expect(createApp()).rejects.toThrow('首次初始化失败');
    const initialized = await createApp();

    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({ routes: ['broken-route'] });
    expect(initialized.server).toBe(servers[1]);
    expect(initialized.server.routes).toEqual(['ready-route']);
    await expect(createApp()).resolves.toBe(initialized);
  });
});
