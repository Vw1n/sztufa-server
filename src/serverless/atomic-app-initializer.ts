import { createSingleFlightInitializer } from './single-flight-initializer';

export function createAtomicAppInitializer<TApp, TServer>(
  createServer: () => TServer,
  initialize: (server: TServer) => Promise<TApp>,
): () => Promise<{ app: TApp; server: TServer }> {
  return createSingleFlightInitializer(async () => {
    const server = createServer();
    const app = await initialize(server);
    return { app, server };
  });
}
