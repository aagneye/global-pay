import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildContainer } from './container.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const container = buildContainer(env);
const app = await buildApp({ container });

container.workers.indexer.start(app.log);
container.workers.payouts.start(app.log);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await container.workers.indexer.stop();
  await container.workers.payouts.stop();
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
