import { type Address, isAddressEqual } from 'viem';
import type { Payment } from '../domain/payment.js';
import type { Quote } from '../domain/quote.js';
import type { CursorRepository, PaymentRepository, PaymentWithQuote, QuoteRepository } from '../ports/repositories.js';
import type { PaymentReceivedEvent, SettlementGateway } from '../ports/settlement-gateway.js';
import { PollingLoop, type WorkerLogger, silentLogger } from './loop.js';

/** Anvil's chain, where starting from block 0 is normal. */
const LOCAL_CHAIN_ID = 31337;

export interface IndexerDeps {
  gateway: SettlementGateway;
  payments: PaymentRepository;
  quotes: QuoteRepository;
  cursors: CursorRepository;
  chainId: number;
  settlementAddress?: Address;
  pollMs: number;
  /** Blocks to wait before treating an event as final. */
  confirmations: number;
  /** Where to start the first time (the contract's deployment block). */
  startBlock: bigint;
  /** Largest block range per log query; RPC providers cap it. */
  maxBlockRange?: bigint;
  /** How long after a quote expires to give up on a SUBMITTED payment that never landed. */
  failAfterExpiryMs?: number;
  now?: () => Date;
}

/**
 * Reads `PaymentReceived` events and moves payments SUBMITTED → PAID. On-chain events are the
 * source of truth: processing an event again has no effect, and the saved block cursor lets it
 * resume after a restart. Events are only read `confirmations` blocks behind the head.
 * An event must match its stored quote field for field (payer, token, amounts, merchant); one that
 * doesn't is never paid out, and is shown to operators.
 *
 * It also reconciles SUBMITTED payments whose pay() never produced an event: a reverted
 * transaction, or one that didn't land before the quote expired, becomes FAILED, but only while the
 * chain shows no payment for the quote. A FAILED payment whose quote is paid later becomes PAID.
 */
export class IndexerWorker {
  private readonly deps: IndexerDeps;
  private readonly loop: PollingLoop;
  private readonly maxBlockRange: bigint;
  private readonly failAfterExpiryMs: number;
  private readonly now: () => Date;
  private log: WorkerLogger = silentLogger;

  constructor(deps: IndexerDeps) {
    this.deps = deps;
    this.maxBlockRange = deps.maxBlockRange ?? 2_000n;
    this.failAfterExpiryMs = deps.failAfterExpiryMs ?? 60_000;
    this.now = deps.now ?? (() => new Date());
    this.loop = new PollingLoop('indexer', deps.pollMs, () => this.tick());
  }

  start(log: WorkerLogger): void {
    this.log = log;
    if (!this.deps.settlementAddress) {
      log.warn({ worker: 'indexer' }, 'SETTLEMENT_ADDRESS is not set; indexer not started');
      return;
    }
    if (this.deps.startBlock === 0n && this.deps.chainId !== LOCAL_CHAIN_ID) {
      log.warn(
        { worker: 'indexer', chainId: this.deps.chainId },
        'INDEXER_START_BLOCK is 0: the first run scans the whole chain. Set it to the deployment block.',
      );
    }
    this.loop.start(log);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /** One pass: index new confirmed blocks, then reconcile stuck payments. */
  async tick(): Promise<void> {
    await this.indexEvents();
    await this.reconcileSubmitted();
  }

  private get cursorId(): string {
    return `settlement:${this.deps.chainId}:${this.deps.settlementAddress?.toLowerCase()}`;
  }

  private async indexEvents(): Promise<void> {
    const { gateway, cursors } = this.deps;
    const safeBlock = (await gateway.getLatestBlock()) - BigInt(this.deps.confirmations);
    let from = ((await cursors.get(this.cursorId)) ?? this.deps.startBlock - 1n) + 1n;

    while (from <= safeBlock) {
      const to = from + this.maxBlockRange - 1n < safeBlock ? from + this.maxBlockRange - 1n : safeBlock;
      for (const event of await gateway.getPaymentReceivedEvents(from, to)) {
        await this.onPaymentReceived(event);
      }
      // Saved after the events: a crash in between re-reads them, which is harmless.
      await cursors.set(this.cursorId, to);
      from = to + 1n;
    }
  }

  private async onPaymentReceived(event: PaymentReceivedEvent): Promise<void> {
    const { payments, quotes } = this.deps;
    const stored = await quotes.findById(event.quoteId);
    if (!stored) {
      this.log.warn({ quoteId: event.quoteId, txHash: event.txHash }, 'PaymentReceived for an unknown quote');
      return;
    }
    // pay() is permissionless, so someone else may have submitted our quote. Track it like our own.
    const payment =
      (await payments.findByQuoteId(event.quoteId)) ?? (await payments.createForQuote(event.quoteId, stored.userId)).payment;

    // The event must be for exactly the quote we signed and stored. Anything else (say, a quote signed
    // with a leaked key under a stored quote's ID, for a smaller amount) is never paid out.
    const mismatch = describeMismatch(event, stored.quote);
    if (mismatch) {
      await this.onMismatch(payment, event, mismatch);
      return;
    }

    if (payment.status === 'SUBMITTED') {
      await payments.transition(payment.id, 'SUBMITTED', 'PAID', {
        payTxHash: event.txHash,
        paidBlock: event.blockNumber,
      });
      this.log.info({ paymentId: payment.id, txHash: event.txHash }, 'payment received on-chain');
    } else if (payment.status === 'FAILED') {
      // Failed while the chain showed no payment, but the quote was paid after all: pay() is permissionless,
      // so the same authorisation can be relayed later. The chain decides; the payment is paid out as usual.
      await payments.transition(payment.id, 'FAILED', 'PAID', {
        payTxHash: event.txHash,
        paidBlock: event.blockNumber,
        failureReason: null,
      });
      this.log.warn({ paymentId: payment.id, txHash: event.txHash }, 'FAILED payment was paid on-chain; now PAID');
    }
    // Any other status: we've seen this event before.
  }

  /** Keeps the payment out of the payout path for good, and flags it for operators. */
  private async onMismatch(payment: Payment, event: PaymentReceivedEvent, mismatch: string): Promise<void> {
    const { payments } = this.deps;
    this.log.error({ paymentId: payment.id, txHash: event.txHash, mismatch }, 'PaymentReceived does not match its quote; not paying out');
    const eventMismatch = `Transaction ${event.txHash}: ${mismatch}`;
    if (payment.status === 'SUBMITTED') {
      const failed = await payments.transition(payment.id, 'SUBMITTED', 'FAILED', {
        failureReason: "The on-chain payment doesn't match the quote",
        eventMismatch,
      });
      if (failed) return;
    }
    await payments.update(payment.id, { eventMismatch });
  }

  private async reconcileSubmitted(): Promise<void> {
    const submitted = await this.deps.payments.listByStatus(['SUBMITTED'], 100);
    for (const item of submitted) {
      try {
        await this.reconcile(item);
      } catch (error) {
        this.log.error({ err: error, paymentId: item.payment.id }, 'could not reconcile payment');
      }
    }
  }

  private async reconcile({ payment, quote }: PaymentWithQuote): Promise<void> {
    const { gateway, payments } = this.deps;
    if (payment.payTxHash) {
      const receipt = await gateway.getReceipt(payment.payTxHash);
      if (receipt?.status === 'reverted') {
        // Another pay() of the same quote may have landed first (a relayer re-sign, or a third party), and
        // ours reverted with QuoteAlreadyUsed: then the USDC is in the contract. Fail only if it isn't.
        const onChain = await gateway.getPaymentStatus(payment.quoteId);
        if (onChain === 'None') {
          await payments.transition(payment.id, 'SUBMITTED', 'FAILED', { failureReason: 'The pay() transaction reverted' });
        } else {
          this.log.warn(
            { paymentId: payment.id, txHash: payment.payTxHash, onChain },
            "pay() reverted, but the quote is paid on-chain; waiting for its PaymentReceived event",
          );
        }
        return;
      }
      if (receipt) return; // mined: its event arrives once confirmed
    }

    // Not mined (or never sent). After the quote expires, the contract rejects it, so it can never land.
    const expired = this.now().getTime() > quote.quote.expiresAt.getTime() + this.failAfterExpiryMs;
    if (!expired) return;
    if ((await gateway.getPaymentStatus(payment.quoteId)) !== 'None') return; // landed after all
    await payments.transition(payment.id, 'SUBMITTED', 'FAILED', {
      failureReason: payment.payTxHash ? 'pay() was not mined before the quote expired' : 'pay() was not sent',
    });
  }
}

/** The fields where the event differs from the stored quote, e.g. "tokenAmount 1 (quote: 3107693)"; null if none. */
export function describeMismatch(event: PaymentReceivedEvent, quote: Quote): string | null {
  const differences: string[] = [];
  const check = (field: string, onChain: string | bigint, stored: string | bigint, same: boolean) => {
    if (!same) differences.push(`${field} ${onChain} (quote: ${stored})`);
  };
  check('payer', event.payer, quote.payer, sameAddress(event.payer, quote.payer));
  check('token', event.token, quote.token, sameAddress(event.token, quote.token));
  check('tokenAmount', event.tokenAmount, quote.tokenAmount, event.tokenAmount === quote.tokenAmount);
  check('fiatCurrency', event.fiatCurrency, quote.fiat.currency, event.fiatCurrency === quote.fiat.currency);
  check('fiatAmount', event.fiatAmount, quote.fiat.minor, event.fiatAmount === quote.fiat.minor);
  check(
    'merchantRefHash',
    event.merchantRefHash,
    quote.merchantRefHash,
    event.merchantRefHash.toLowerCase() === quote.merchantRefHash.toLowerCase(),
  );
  return differences.length ? differences.join(', ') : null;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return isAddressEqual(a as Address, b as Address);
  } catch {
    return false;
  }
}
