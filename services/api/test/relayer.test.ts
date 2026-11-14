import { type Hex, custom, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { ViemSettlementGateway } from '../src/adapters/chain/viem-settlement-gateway.js';
import { ANVIL } from './support/anvil.js';

/** A fake node: simulations pass, and it records what was broadcast. */
function fakeNode(log: string[]) {
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case 'eth_chainId':
        return `0x${ANVIL.chainId.toString(16)}`;
      case 'eth_call':
        return '0x';
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_maxPriorityFeePerGas':
        return '0x1';
      case 'eth_getBlockByNumber':
        return { number: '0x1', hash: `0x${'00'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1c9c380', transactions: [] };
      case 'eth_sendRawTransaction': {
        const [raw] = params as [Hex];
        log.push(`broadcast ${keccak256(raw)}`);
        return keccak256(raw);
      }
      case 'eth_getTransactionByHash':
        return null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return custom({ request }, { retryCount: 0 });
}

const transfer = {
  token: ANVIL.usdc,
  from: ANVIL.accounts.payer.address,
  to: ANVIL.accounts.treasury.address,
  value: 5_000_000n,
  validAfter: 0n,
  validBefore: 2_000_000_000n,
  nonce: `0x${'ab'.repeat(32)}` as Hex,
  signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex,
};

function gateway(log: string[]) {
  return new ViemSettlementGateway({
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: ANVIL.chainId,
    relayerPrivateKey: ANVIL.accounts.quoteSigner.privateKey, // any key will do for the fake node
    transport: fakeNode(log),
  });
}

describe('Relayer beforeBroadcast', () => {
  it('hands over the signed transaction hash before broadcasting it', async () => {
    const log: string[] = [];
    const hash = await gateway(log).submitTransfer(transfer, {
      beforeBroadcast: async (txHash) => void log.push(`stored ${txHash}`),
    });
    expect(log).toEqual([`stored ${hash}`, `broadcast ${hash}`]);
  });

  it('broadcasts nothing when it throws', async () => {
    const log: string[] = [];
    const refused = new Error('request changed');
    await expect(
      gateway(log).submitTransfer(transfer, {
        beforeBroadcast: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    expect(log).toEqual([]);
  });
});
