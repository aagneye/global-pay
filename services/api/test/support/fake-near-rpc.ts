import { createHash } from 'node:crypto';
import { type SignedTransaction, baseEncode, decodeSignedTransaction } from 'near-api-js';

type Handler = (params: Record<string, unknown>) => unknown;

/** A JSON-RPC error body, as nearcore sends it. */
export function rpcError(causeName: string, info: unknown = {}, data?: unknown) {
  return { __error: { name: 'HANDLER_ERROR', cause: { name: causeName, info }, code: -32000, message: 'Server error', data } };
}

/**
 * A NEAR JSON-RPC node in memory, as `fetch`, for NearSettlementGateway tests. Views answer from `views`
 * (by "contract.method"), transactions are decoded and kept in `sent`, and `next` overrides one method's
 * next answer (return `rpcError(...)` to fail, or throw to act as a network failure).
 */
export class FakeNearRpc {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly sent: { hash: string; tx: SignedTransaction }[] = [];
  readonly accessKeys = new Map<string, bigint>();
  readonly accounts = new Map<string, bigint>();
  readonly views = new Map<string, (args: Record<string, unknown>) => unknown>();
  readonly txStatuses = new Map<string, unknown>();
  readonly next = new Map<string, Handler>();
  finalHeight = 1_000;
  readonly blockHash = baseEncode(new Uint8Array(32).fill(9));

  readonly fetch: typeof fetch = async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    this.calls.push({ method, params });
    const override = this.next.get(method);
    if (override) this.next.delete(method);
    const result = (override ?? ((p: Record<string, unknown>) => this.answer(method, p)))(params) as { __error?: unknown } | undefined;
    const body = result && typeof result === 'object' && '__error' in result ? { error: result.__error } : { result };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), { headers: { 'content-type': 'application/json' } });
  };

  /** The view calls made, as "contract.method" with their JSON arguments. */
  viewCalls(): { target: string; args: Record<string, unknown> }[] {
    return this.calls
      .filter((c) => c.method === 'query' && c.params.request_type === 'call_function')
      .map((c) => ({
        target: `${c.params.account_id}.${c.params.method_name}`,
        args: JSON.parse(Buffer.from(String(c.params.args_base64), 'base64').toString('utf8')),
      }));
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'query':
        return this.query(params);
      case 'block':
        return { header: { height: this.finalHeight, hash: this.blockHash } };
      case 'send_tx': {
        const bytes = Buffer.from(String(params.signed_tx_base64), 'base64');
        const tx = decodeSignedTransaction(bytes);
        const hash = baseEncode(createHash('sha256').update(tx.transaction.encode()).digest());
        this.sent.push({ hash, tx });
        const key = `${tx.transaction.signerId}:${tx.transaction.publicKey.toString()}`;
        this.accessKeys.set(key, BigInt(tx.transaction.nonce));
        return { final_execution_status: 'NONE' };
      }
      case 'EXPERIMENTAL_tx_status': {
        const status = this.txStatuses.get(String(params.tx_hash));
        return status ?? rpcError('UNKNOWN_TRANSACTION');
      }
      default:
        throw new Error(`FakeNearRpc: no ${method}`);
    }
  }

  private query(params: Record<string, unknown>): unknown {
    // Error shapes as testnet's RPC sends them (checked against test.rpc.fastnear.com).
    const inResult = (error: string) => ({ block_hash: this.blockHash, block_height: this.finalHeight, error, logs: [] });
    if (params.request_type === 'view_access_key') {
      const nonce = this.accessKeys.get(`${params.account_id}:${params.public_key}`);
      if (nonce === undefined) return inResult(`access key ${String(params.public_key)} does not exist while viewing`);
      return { nonce: Number(nonce), permission: 'FullAccess' };
    }
    if (params.request_type === 'view_account') {
      const amount = this.accounts.get(String(params.account_id));
      return amount === undefined ? rpcError('UNKNOWN_ACCOUNT') : { amount: amount.toString(), locked: '0', storage_usage: 100 };
    }
    if (params.request_type === 'call_function') {
      const view = this.views.get(`${params.account_id}.${params.method_name}`);
      if (!view) return inResult('wasm execution failed with error: MethodResolveError(MethodNotFound)');
      const args = JSON.parse(Buffer.from(String(params.args_base64), 'base64').toString('utf8'));
      return { result: [...Buffer.from(JSON.stringify(view(args)))], logs: [], block_height: this.finalHeight };
    }
    throw new Error(`FakeNearRpc: no query ${String(params.request_type)}`);
  }
}
