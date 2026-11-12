/**
 * Writes the OpenAPI spec to packages/openapi/openapi.json, where the mobile app's client is
 * generated from. Run it after changing a route: npm run openapi
 * test/openapi.test.ts fails if the committed file is out of date.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { buildContainer } from '../src/container.js';
import { loadEnv } from '../src/config/env.js';

export const SPEC_PATH = fileURLToPath(new URL('../../../packages/openapi/openapi.json', import.meta.url));

/** The spec as the server serves it at /docs/json, formatted for a stable diff. */
export async function renderOpenApi(): Promise<string> {
  // Placeholder settings: building the app doesn't connect to anything.
  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused',
    JWT_SECRET: 'x'.repeat(32),
    RPC_URL: 'http://127.0.0.1:8545',
    USDC_ADDRESS: '0x0000000000000000000000000000000000000001',
  });
  const container = buildContainer(env);
  const app = await buildApp({ container, logger: false });
  await app.ready();
  const spec = app.swagger();
  await app.close();
  await container.close();
  return `${JSON.stringify(spec, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(SPEC_PATH, await renderOpenApi());
  console.log(`Wrote ${SPEC_PATH}`);
}
