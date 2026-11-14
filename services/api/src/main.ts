import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildContainer } from './container.js';
import { installCrashHandlers } from './shared/logging.js';

// `--env <path>` loads that settings file instead of .env, e.g. .env.base-sepolia (from `npm run testnet -- init`).
// Only one file is loaded, so two setups never mix. (Not --env-file: Node takes that one for itself.)
const flag = process.argv.indexOf('--env');
const envFile = flag === -1 ? '.env' : process.argv[flag + 1];
if (!envFile) throw new Error('--env needs a path');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else if (flag !== -1) throw new Error(`No such env file: ${envFile}`);

const env = loadEnv();
const container = buildContainer(env);
const app = await buildApp({ container });
// From here on, anything nothing caught is logged scrubbed; an uncaught exception exits 1.
installCrashHandlers(app.log);

container.workers.indexer.start(app.log);
container.workers.payouts.start(app.log);
container.workers.onramp.start(app.log);
container.workers.deposits.start(app.log);
container.workers.p2p.start(app.log);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await container.workers.indexer.stop();
  await container.workers.payouts.stop();
  await container.workers.onramp.stop();
  await container.workers.deposits.stop();
  await container.workers.p2p.stop();
  await app.close();
  await container.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'could not start the server');
  process.exit(1);
}
