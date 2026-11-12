import { type Hex, custom, encodeAbiParameters, toFunctionSelector } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ViemSettlementGateway } from '../src/adapters/chain/viem-settlement-gateway.js';
import { ANVIL } from './support/anvil.js';

const NAME = toFunctionSelector('name()');
const VERSION = toFunctionSelector('version()');

/** A fake JSON-RPC endpoint that answers eth_call for name() and version(). */
function fakeToken(values: { name: string; version?: string }) {
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const [{ data }] = params as [{ data: Hex }];
    const value = data.startsWith(NAME) ? values.name : data.startsWith(VERSION) ? values.version : undefined;
    if (value === undefined) throw new Error('execution reverted');
    return encodeAbiParameters([{ type: 'string' }], [value]);
  });
  return { request, transport: custom({ request }, { retryCount: 0 }) };
}

function gateway(transport: ReturnType<typeof fakeToken>['transport']) {
  return new ViemSettlementGateway({ rpcUrl: 'http://127.0.0.1:8545', chainId: ANVIL.chainId, transport });
}

describe('ViemSettlementGateway.getTokenDomain', () => {
  it('reads name and version from the token and caches them', async () => {
    const token = fakeToken({ name: 'USDC', version: '2' });
    const chain = gateway(token.transport);

    await expect(chain.getTokenDomain(ANVIL.usdc)).resolves.toEqual({ name: 'USDC', version: '2' });
    await chain.getTokenDomain(ANVIL.usdc);
    expect(token.request).toHaveBeenCalledTimes(2);
  });

  it('fails with 503 when the token has no version(), and retries next time', async () => {
    const token = fakeToken({ name: 'USDC' });
    const chain = gateway(token.transport);

    await expect(chain.getTokenDomain(ANVIL.usdc)).rejects.toMatchObject({
      code: 'chain_unavailable',
      statusCode: 503,
    });
    await expect(chain.getTokenDomain(ANVIL.usdc)).rejects.toThrow(/EIP-712 domain/);
    expect(token.request.mock.calls.length).toBeGreaterThan(2);
  });
});
