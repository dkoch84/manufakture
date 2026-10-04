import { buildApp } from './app';
import { loadConfig } from './config';
import { SqliteShareStore } from './shares';
import { SqliteStore } from './sqlite';

/** `pnpm --filter @manufakture/server start`: reads the environment, opens the database, listens. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const store = new SqliteStore(config.databasePath);
  const app = await buildApp({
    token: config.token,
    store,
    limits: config.limits,
    origins: config.origins,
    trustProxy: config.trustProxy,
    logger: { level: config.logLevel },
    ...(config.shares && {
      shares: { store: new SqliteShareStore(store.database), config: config.shares },
    }),
  });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal}: closing`);
    app
      .close()
      .catch((e: unknown) => app.log.error(e))
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ host: config.host, port: config.port });
}

void main();
