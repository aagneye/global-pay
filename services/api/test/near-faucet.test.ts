import type { Action } from 'near-api-js';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { FAUCET_NEAR_YOCTO, type NearRelayerClient, NearTestnetFaucet } from '../src/adapters/near/faucet.js';
import type { TxReceipt } from '../src/ports/settlement-gateway.js';

const ACCOUNT = 'ab'.repeat(32);
const USDC = 'gp-test01-usdc.testnet';

class FakeRelayer implements NearRelayerClient {
  exists = false;
  registered = false;
  failSends = false;
  readonly sent: { receiverId: string; actions: Action[] }[] = [];

  async accountExists(): Promise<boolean> {
    return this.exists;
  }

  async view<T>(_contract: string, method: string): Promise<T> {
    if (method === 'storage_balance_of') return (this.registered ? { total: '1', available: '0' } : null) as T;
    if (method === 'storage_balance_bounds') return { min: '1250000000000000000000', max: null } as T;
    throw new Error(method);
  }

  async sendFromRelayer(receiverId: string, actions: Action[]): Promise<Hex> {
    if (this.failSends) throw new Error('relayer is out of NEAR');
    this.sent.push({ receiverId, actions });
    return `hash${this.sent.length}` as Hex;
  }

  async waitForReceipt(): Promise<TxReceipt> {
    return { status: 'success', blockNumber: 1n };
  }
}

describe('NearTestnetFaucet', () => {
  it('creates the account, registers it with the token and mints 1,000 USDC', async () => {
    const relayer = new FakeRelayer();
    await new NearTestnetFaucet({ relayer, usdcContract: USDC }).onboard(ACCOUNT);

    expect(relayer.sent.map((s) => s.receiverId)).toEqual([ACCOUNT, USDC]);
    expect(relayer.sent[0]?.actions[0]?.transfer?.deposit).toBe(FAUCET_NEAR_YOCTO);
    const [deposit, mint] = relayer.sent[1]!.actions.map((a) => a.functionCall!);
    expect(deposit?.methodName).toBe('storage_deposit');
    expect(deposit?.deposit).toBe(1_250_000_000_000_000_000_000n);
    expect(JSON.parse(Buffer.from(deposit!.args).toString())).toEqual({ account_id: ACCOUNT, registration_only: true });
    expect(mint?.methodName).toBe('mint');
    expect(JSON.parse(Buffer.from(mint!.args).toString())).toEqual({ account_id: ACCOUNT, amount: '1000000000' });
  });

  it('does only what is missing', async () => {
    const relayer = new FakeRelayer();
    relayer.exists = true;
    relayer.registered = true;
    await new NearTestnetFaucet({ relayer, usdcContract: USDC }).onboard(ACCOUNT);
    expect(relayer.sent).toEqual([]);

    relayer.registered = false;
    await new NearTestnetFaucet({ relayer, usdcContract: USDC }).onboard(ACCOUNT);
    expect(relayer.sent.map((s) => s.receiverId)).toEqual([USDC]);
  });

  it('logs failures instead of throwing', async () => {
    const relayer = new FakeRelayer();
    relayer.failSends = true;
    const warnings: string[] = [];
    const faucet = new NearTestnetFaucet({ relayer, usdcContract: USDC });
    faucet.useLogger({ info() {}, error() {}, warn: (_o: unknown, message?: string) => void warnings.push(message ?? '') } as never);
    await expect(faucet.onboard(ACCOUNT)).resolves.toBeUndefined();
    expect(warnings).toEqual(['testnet onboarding failed']);
  });
});
