import { createSingleFlightInitializer } from './single-flight-initializer';

describe('createSingleFlightInitializer', () => {
  it('并发冷启动只执行一次初始化，并让所有请求等待同一个实例', async () => {
    let initializeCount = 0;
    let finishInitialization: ((value: { ready: boolean }) => void) | undefined;
    const initializer = createSingleFlightInitializer(
      () =>
        new Promise<{ ready: boolean }>((resolve) => {
          initializeCount++;
          finishInitialization = resolve;
        }),
    );

    const requests = Array.from({ length: 20 }, () => initializer());
    expect(initializeCount).toBe(1);

    finishInitialization?.({ ready: true });
    const instances = await Promise.all(requests);

    expect(instances.every((instance) => instance === instances[0])).toBe(true);
    await expect(initializer()).resolves.toBe(instances[0]);
    expect(initializeCount).toBe(1);
  });

  it('初始化失败后允许后续请求重试', async () => {
    let initializeCount = 0;
    const initializer = createSingleFlightInitializer(async () => {
      initializeCount++;
      if (initializeCount === 1) {
        throw new Error('首次冷启动失败');
      }
      return { ready: true };
    });

    await expect(initializer()).rejects.toThrow('首次冷启动失败');
    await expect(initializer()).resolves.toEqual({ ready: true });
    expect(initializeCount).toBe(2);
  });
});
