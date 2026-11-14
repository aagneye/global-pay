/**
 * A small NEAR JSON-RPC client (https://docs.near.org/api/rpc/introduction) over fetch.
 * Reads use `finality: "final"`. near-api-js builds and signs transactions; this only moves JSON.
 */

/** The node answered with an error, e.g. UNKNOWN_ACCOUNT or INVALID_TRANSACTION. */
export class NearRpcError extends Error {
  /** The error's cause name (e.g. "INVALID_TRANSACTION"), or its name when there's no cause. */
  readonly kind: string;
  readonly data: unknown;

  constructor(kind: string, message: string, data?: unknown) {
    super(message);
    this.name = 'NearRpcError';
    this.kind = kind;
    this.data = data;
  }
}

/** The node couldn't be reached, timed out, or answered with something that isn't JSON-RPC. */
export class NearRpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearRpcUnavailableError';
  }
}

export type TxWaitUntil = 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'INCLUDED_FINAL' | 'EXECUTED' | 'FINAL';

export interface ExecutionStatus {
  SuccessValue?: string;
  SuccessReceiptId?: string;
  Failure?: unknown;
  Unknown?: unknown;
}

export interface FinalExecutionOutcome {
  final_execution_status?: TxWaitUntil;
  status?: ExecutionStatus | string;
  transaction?: { hash: string; signer_id: string };
  transaction_outcome?: { id: string; block_hash: string; outcome: { status: ExecutionStatus | string } };
  receipts_outcome?: { id: string; block_hash: string; outcome: { status: ExecutionStatus | string } }[];
}

export interface NearRpcOptions {
  url: string;
  /** Per request. send_tx and tx_status waits are bounded by the node (about 10 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class NearRpc {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private nextId = 1;

  constructor(options: NearRpcOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new NearRpcUnavailableError(`NEAR RPC ${method} failed: ${(error as Error).message}`);
    }
    let body: { result?: T; error?: RpcErrorBody };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new NearRpcUnavailableError(`NEAR RPC ${method} answered HTTP ${response.status} without JSON`);
    }
    if (body.error) {
      const { name, cause, message, data } = body.error;
      const kind = cause?.name ?? name ?? 'UNKNOWN';
      const detail = typeof data === 'string' ? data : JSON.stringify(cause?.info ?? data ?? message ?? '');
      throw new NearRpcError(kind, `NEAR RPC ${method}: ${kind} ${detail}`.trim(), data ?? cause?.info);
    }
    if (body.result === undefined) throw new NearRpcUnavailableError(`NEAR RPC ${method} returned no result`);
    return body.result;
  }

  /** Calls a view method with JSON arguments and parses its JSON result. */
  async viewFunction<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    const result = await this.call<{ result?: number[]; error?: string }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    // Older nodes report a failing view call inside the result.
    if (result.error || !result.result) throw new NearRpcError('CONTRACT_EXECUTION_ERROR', result.error ?? 'no result');
    return JSON.parse(Buffer.from(result.result).toString('utf8')) as T;
  }

  viewAccount(accountId: string): Promise<{ amount: string; locked: string; storage_usage: number }> {
    return this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<{ nonce: number | string; permission: unknown }> {
    return this.call('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
  }

  block(reference: { finality: 'final' } | { block_id: string | number }): Promise<{ header: { height: number; hash: string } }> {
    return this.call('block', reference);
  }

  sendTx(signedTxBase64: string, waitUntil: TxWaitUntil): Promise<FinalExecutionOutcome> {
    return this.call('send_tx', { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
  }

  txStatus(txHash: string, senderAccountId: string, waitUntil: TxWaitUntil): Promise<FinalExecutionOutcome> {
    return this.call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: waitUntil });
  }
}

interface RpcErrorBody {
  name?: string;
  cause?: { name?: string; info?: unknown };
  message?: string;
  data?: unknown;
}
