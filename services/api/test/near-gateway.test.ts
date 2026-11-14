import { PublicKey, baseEncode } from 'near-api-js';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { NearSettlementGateway } from '../src/adapters/near/near-settlement-gateway.js';
import type { SignedQuote } from '../src/domain/quote.js';
import { ChainUnavailableError, TransactionRejectedError } from '../src/ports/settlement-gateway.js';
import { FakeNearRpc, rpcError } from './support/fake-near-rpc.js';
import { NEAR, implicitAccount, signNearPayment } from './support/near.js';

const PAYER = implicitAccount(NEAR.payerKey);
const RELAYER_PK = NEAR.relayerKey.getPublicKey().toString();
const QUOTE_ID = `0x${'ab'.repeat(32)}` as Hex;

function setup() {
  const rpc = new FakeNearRpc();
  rpc.accessKeys.set(`${NEAR.relayer}:${RELAYER_PK}`, 500n);
  const gateway = new NearSettlementGateway({
    rpcUrl: 'http://near.test',
    settlementContract: NEAR.settlement,
    relayerAccountId: NEAR.relayer,
    relayerPrivateKey: NEAR.relayerKey.toString(),
    pollingIntervalMs: 1,
    receiptTimeoutMs: 50,
    fetch: rpc.fetch,
  });
  return { rpc, gateway };
}

const view = (quoteId: string, index: number, status = 'Paid') => ({
  quote_id: quoteId,
  payer: PAYER,
  token: NEAR.usdc,
  token_amount: '3107693',
  fiat_currency: 'THB',
  fiat_amount: '10000',
  merchant_ref_hash: `0x${'cd'.repeat(32)}`,
  status,
  paid_block: 190_000_123,
  index,
});

const signedQuote = { quote: { quoteId: QUOTE_ID }, signature: 'c2ln' } as unknown as SignedQuote;

async function delegate(): Promise<string> {
  return signNearPayment(NEAR.payerKey, {
    signerId: PAYER,
    publicKey: NEAR.payerKey.getPublicKey().toString(),
    receiverId: NEAR.usdc,
    methodName: 'ft_transfer_call',
    args: { receiver_id: NEAR.settlement, amount: '3107693', msg: '{}' },
    gas: '100000000000000',
    deposit: '1',
    nonce: '42',
    maxBlockHeight: '1300',
  });
}

describe('NearSettlementGateway', () => {
  it('relays a signed delegate from the relayer to the sender, nonces in order', async () => {
    const { rpc, gateway } = setup();
    const hash = await gateway.submitPayment(signedQuote, { kind: 'near-delegate', signedDelegate: await delegate() });

    const [first] = rpc.sent;
    expect(first?.hash).toBe(hash);
    const tx = first!.tx.transaction;
    expect(tx).toMatchObject({ signerId: NEAR.relayer, receiverId: PAYER, nonce: 501n });
    expect(tx.publicKey.toString()).toBe(RELAYER_PK);
    expect(baseEncode(Uint8Array.from(tx.blockHash))).toBe(rpc.blockHash);
    expect(tx.actions).toHaveLength(1);
    const inner = tx.actions[0]?.signedDelegate?.delegateAction;
    expect(inner).toMatchObject({ senderId: PAYER, receiverId: NEAR.usdc });
    expect(first!.tx.signature.data).toHaveLength(64);
    expect(PublicKey.fromString(RELAYER_PK).verify(Buffer.from(hashBytes(hash)), first!.tx.signature.data)).toBe(true);

    await gateway.markSettled(QUOTE_ID);
    const settle = rpc.sent[1]!.tx.transaction;
    expect(settle).toMatchObject({ receiverId: NEAR.settlement, nonce: 502n });
    const call = settle.actions[0]?.functionCall;
    expect(call?.methodName).toBe('settle');
    expect(JSON.parse(Buffer.from(call!.args).toString())).toEqual({ quote_id: QUOTE_ID });
    expect(call?.gas).toBe(100_000_000_000_000n);
  });

  it('reads the nonce again once when the node says it is stale', async () => {
    const { rpc, gateway } = setup();
    rpc.next.set('send_tx', () => {
      rpc.accessKeys.set(`${NEAR.relayer}:${RELAYER_PK}`, 900n);
      return rpcError('INVALID_TRANSACTION', {}, { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 501, ak_nonce: 900 } } } });
    });
    await gateway.refund(QUOTE_ID);
    expect(rpc.sent[0]?.tx.transaction.nonce).toBe(901n);
  });

  it('reports a refused transaction as nothing sent, and a lost connection with its hash', async () => {
    const { rpc, gateway } = setup();
    rpc.next.set('send_tx', () => rpcError('INVALID_TRANSACTION', {}, { TxExecutionError: { InvalidTxError: 'NotEnoughBalance' } }));
    await expect(gateway.markSettled(QUOTE_ID)).rejects.toBeInstanceOf(TransactionRejectedError);

    rpc.next.set('send_tx', () => {
      throw new Error('socket hang up');
    });
    const error = await gateway.markSettled(QUOTE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as ChainUnavailableError).txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    rpc.next.set('block', () => {
      throw new Error('offline');
    });
    const before = await gateway.markSettled(QUOTE_ID).catch((e: unknown) => e);
    expect(before).toBeInstanceOf(ChainUnavailableError);
    expect((before as ChainUnavailableError).txHash).toBeUndefined();
  });

  it('maps the contract sequence to blocks: block n is index n - 1, in pages of 100', async () => {
    const { rpc, gateway } = setup();
    rpc.views.set(`${NEAR.settlement}.paid_count`, () => 2);
    rpc.views.set(`${NEAR.settlement}.get_paid_events`, ({ from_index, limit }) =>
      Array.from({ length: Math.min(Number(limit), 2 - Number(from_index)) }, (_v, i) => view(`0x${String(Number(from_index) + i).padStart(64, '0')}`, Number(from_index) + i)),
    );
    expect(await gateway.getLatestBlock()).toBe(2n);
    const events = await gateway.getPaymentReceivedEvents(0n, 2n);
    expect(events.map((e) => e.logIndex)).toEqual([0, 1]);
    expect(events[0]).toMatchObject({ payer: PAYER, token: NEAR.usdc, tokenAmount: 3_107_693n, fiatAmount: 10_000n, blockNumber: 190_000_123n });
    expect(events[0]?.txHash).toBeUndefined();
    expect(rpc.viewCalls().at(-1)).toEqual({ target: `${NEAR.settlement}.get_paid_events`, args: { from_index: 0, limit: 2 } });

    await gateway.getPaymentReceivedEvents(3n, 3n);
    expect(rpc.viewCalls().at(-1)?.args).toEqual({ from_index: 2, limit: 1 });
    await gateway.getPaymentReceivedEvents(1n, 250n);
    expect(rpc.viewCalls().slice(-3).map((c) => c.args)).toEqual([
      { from_index: 0, limit: 100 },
      { from_index: 100, limit: 100 },
      { from_index: 200, limit: 50 },
    ]);
  });

  it('gives events the hash it relayed', async () => {
    const { rpc, gateway } = setup();
    const hash = await gateway.submitPayment(signedQuote, { kind: 'near-delegate', signedDelegate: await delegate() });
    rpc.views.set(`${NEAR.settlement}.get_paid_events`, () => [view(QUOTE_ID, 0)]);
    expect((await gateway.getPaymentReceivedEvents(1n, 1n))[0]?.txHash).toBe(hash);
  });

  it('reads payment status, balances and keys', async () => {
    const { rpc, gateway } = setup();
    rpc.views.set(`${NEAR.settlement}.get_payment`, ({ quote_id }) => (quote_id === QUOTE_ID ? view(QUOTE_ID, 0, 'Settled') : null));
    rpc.views.set(`${NEAR.usdc}.ft_balance_of`, ({ account_id }) => (account_id === PAYER ? '1000000000' : '0'));
    rpc.accounts.set(NEAR.relayer, 7n * 10n ** 24n);

    expect(await gateway.getPaymentStatus(QUOTE_ID)).toBe('Settled');
    expect(await gateway.getPaymentStatus(`0x${'00'.repeat(32)}`)).toBe('None');
    expect(await gateway.getTokenBalance(NEAR.usdc as Hex, PAYER as Hex)).toBe(1_000_000_000n);
    expect(await gateway.getRelayerBalance()).toEqual({ address: NEAR.relayer, wei: 7n * 10n ** 24n });
    expect(await gateway.getAccessKeyNonce(NEAR.relayer, RELAYER_PK)).toBe(500n);
    expect(await gateway.getAccessKeyNonce(PAYER, NEAR.payerKey.getPublicKey().toString())).toBeNull();
    expect(await gateway.getFinalBlockHeight()).toBe(1_000n);
    expect(rpc.calls.filter((c) => c.method === 'query').every((c) => c.params.finality === 'final')).toBe(true);
    await expect(gateway.getTokenDomain()).rejects.toMatchObject({ code: 'not_configured', statusCode: 503 });
    await expect(gateway.submitTransfer()).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('turns transaction outcomes into receipts', async () => {
    const { rpc, gateway } = setup();
    const outcome = (status: object, receipts: object[] = [], final = 'FINAL') => ({
      final_execution_status: final,
      status,
      transaction_outcome: { id: 'x', block_hash: rpc.blockHash, outcome: { status: { SuccessReceiptId: 'r' } } },
      receipts_outcome: receipts.map((s) => ({ id: 'r', block_hash: rpc.blockHash, outcome: { status: s } })),
    });
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    rpc.txStatuses.set('ok', outcome({ SuccessValue: b64('true') }, [{ SuccessValue: '' }]));
    rpc.txStatuses.set('rolled-back', outcome({ SuccessValue: b64('false') }, [{ Failure: {} }, { SuccessValue: b64('false') }]));
    rpc.txStatuses.set('panicked', outcome({ SuccessValue: b64('"0"') }, [{ SuccessValue: '' }, { Failure: { ActionError: {} } }]));
    rpc.txStatuses.set('pending', outcome({}, [], 'INCLUDED'));

    expect(await gateway.getReceipt('ok' as Hex)).toEqual({ status: 'success', blockNumber: 1_000n });
    expect((await gateway.getReceipt('rolled-back' as Hex))?.status).toBe('reverted');
    expect((await gateway.getReceipt('panicked' as Hex))?.status).toBe('reverted');
    expect(await gateway.getReceipt('pending' as Hex)).toBeNull();
    expect(await gateway.getReceipt('unknown' as Hex)).toBeNull();
    expect((await gateway.waitForReceipt('ok' as Hex)).status).toBe('success');
    await expect(gateway.waitForReceipt('unknown' as Hex)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(rpc.calls.find((c) => c.method === 'EXPERIMENTAL_tx_status')?.params.sender_account_id).toBe(NEAR.relayer);
  });

  it('needs the relayer to send', async () => {
    const gateway = new NearSettlementGateway({ rpcUrl: 'http://near.test', settlementContract: NEAR.settlement, fetch: new FakeNearRpc().fetch });
    await expect(gateway.markSettled(QUOTE_ID)).rejects.toMatchObject({ code: 'not_configured' });
    expect(await gateway.getRelayerBalance()).toBeNull();
  });
});

function hashBytes(base58: string): Uint8Array {
  return PublicKey.fromString(`ed25519:${base58}`).data;
}
