import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { type Adapters, type Container, buildContainer } from '../../src/container.js';
import type { SettlementGateway } from '../../src/ports/settlement-gateway.js';
import { NotImplementedError } from '../../src/shared/errors.js';
import { testEnv } from '../helpers.js';
import { ANVIL } from './anvil.js';
import { type MemoryRepositories, createMemoryRepositories } from './memory-repositories.js';

/** Chain access without a chain: the token domain is USDC's on Base Sepolia (and the mock's). */
export class FakeGateway implements SettlementGateway {
  async getTokenDomain() {
    return { name: 'USDC', version: '2' };
  }
  async submitPayment(): Promise<Hex> {
    throw new NotImplementedError('fake', 4);
  }
  async markSettled(): Promise<Hex> {
    throw new NotImplementedError('fake', 4);
  }
  async refund(): Promise<Hex> {
    throw new NotImplementedError('fake', 4);
  }
  async waitForReceipt(): Promise<never> {
    throw new NotImplementedError('fake', 4);
  }
  async getLatestBlock(): Promise<bigint> {
    throw new NotImplementedError('fake', 4);
  }
  async getPaymentReceivedEvents(): Promise<never[]> {
    throw new NotImplementedError('fake', 4);
  }
  async getTokenBalance(): Promise<bigint> {
    throw new NotImplementedError('fake', 4);
  }
}

export interface TestApp {
  app: FastifyInstance;
  repos: MemoryRepositories;
  env: Env;
  container: Container;
}

/**
 * The real app, wired like production except for the outside world: in-memory storage,
 * a fake chain, a fixed 32.50 THB/USDC rate, and anvil's quote-signer key and addresses.
 */
export async function buildTestApp(
  options: { env?: Record<string, string>; adapters?: Partial<Adapters> } = {},
): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const env = testEnv({
    CHAIN_ID: String(ANVIL.chainId),
    USDC_ADDRESS: ANVIL.usdc,
    SETTLEMENT_ADDRESS: ANVIL.settlement,
    QUOTE_SIGNER_PRIVATE_KEY: ANVIL.accounts.quoteSigner.privateKey,
    RATE_SOURCE: 'fixed',
    FIXED_USDC_THB_RATE: '32.50',
    ...options.env,
  });
  const container = buildContainer(env, { repositories: repos, gateway: new FakeGateway(), ...options.adapters });
  const app = await buildApp({ container, logger: false });
  return { app, repos, env, container };
}

/** Signs in through the HTTP API with a wallet key, as the app would. */
export async function signIn(
  app: FastifyInstance,
  privateKey: Hex,
): Promise<{ token: string; userId: string; address: Address; auth: { authorization: string } }> {
  const account = privateKeyToAccount(privateKey);
  const nonce = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: account.address } });
  const { message } = nonce.json<{ message: string }>();
  const signature = await account.signMessage({ message });
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } });
  if (verify.statusCode !== 200) throw new Error(`sign-in failed: ${verify.body}`);
  const { token, user } = verify.json<{ token: string; user: { id: string } }>();
  return { token, userId: user.id, address: account.address, auth: { authorization: `Bearer ${token}` } };
}

/** Signs in and passes mock KYC (tier 1). */
export async function signInVerified(app: FastifyInstance, privateKey: Hex) {
  const session = await signIn(app, privateKey);
  await app.inject({ method: 'POST', url: '/kyc/start', headers: session.auth });
  await app.inject({ method: 'GET', url: '/kyc/status', headers: session.auth });
  return session;
}
