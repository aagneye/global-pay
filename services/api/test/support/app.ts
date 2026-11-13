import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { type Adapters, type Container, buildContainer } from '../../src/container.js';
import { testEnv } from '../helpers.js';
import { ANVIL } from './anvil.js';
import { FakeChain } from './fake-chain.js';
import { type MemoryRepositories, createMemoryRepositories } from './memory-repositories.js';

export interface TestApp {
  app: FastifyInstance;
  repos: MemoryRepositories;
  env: Env;
  container: Container;
  chain: FakeChain;
}

/**
 * The real app, wired like production except for the outside world: in-memory storage,
 * a fake chain (FakeChain), a fixed 32.50 THB/USDC rate, and anvil's quote-signer key and addresses.
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
    PAYOUT_RECHECK_MS: '0',
    ...options.env,
  });
  const chain = new FakeChain();
  const container = buildContainer(env, { repositories: repos, gateway: chain, ...options.adapters });
  const app = await buildApp({ container, logger: false });
  return { app, repos, env, container, chain };
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

export interface QuoteJson {
  quote: { quoteId: Hex; tokenAmount: string; fiatAmount: string; expiresAt: number };
  signature: Hex;
  authorizationToSign: {
    types: Record<string, { name: string; type: string }[]>;
    primaryType: 'ReceiveWithAuthorization';
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    message: Record<string, string>;
  };
}

/** POST /quotes, expecting success. */
export async function createQuote(
  app: FastifyInstance,
  session: { address: Address; auth: { authorization: string } },
  qrPayload: string,
  fiatAmountMinor?: string,
): Promise<QuoteJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: session.auth,
    payload: { payer: session.address, qrPayload, ...(fiatAmountMinor ? { fiatAmountMinor } : {}) },
  });
  if (response.statusCode !== 201) throw new Error(`quote failed: ${response.body}`);
  return response.json<QuoteJson>();
}

/** What the app does with `authorizationToSign`: sign it with the payer's wallet. */
export async function signAuthorization(privateKey: Hex, quote: QuoteJson): Promise<Hex> {
  const typed = quote.authorizationToSign;
  return privateKeyToAccount(privateKey).signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
}

/** POST /payments with the signed authorisation. Returns the raw response. */
export function submitPayment(
  app: FastifyInstance,
  session: { auth: { authorization: string } },
  quote: QuoteJson,
  signature: Hex,
  overrides: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/payments',
    headers: session.auth,
    payload: {
      quoteId: quote.quote.quoteId,
      validAfter: quote.authorizationToSign.message.validAfter,
      validBefore: quote.authorizationToSign.message.validBefore,
      signature,
      ...overrides,
    },
  });
}
