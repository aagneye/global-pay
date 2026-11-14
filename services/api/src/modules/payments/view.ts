import type { Address, Hex } from 'viem';
import type { PaymentStatus, PayoutStatus } from '../../domain/payment.js';
import type { PaymentWithQuote } from '../../ports/repositories.js';

/** A payment as the app sees it. Amounts are integer strings in minor units. */
export interface PaymentView {
  id: string;
  quoteId: Hex;
  status: PaymentStatus;
  fiatCurrency: string;
  fiatAmount: string;
  token: Address;
  tokenAmount: string;
  merchant: { kind: string; targetId: string; name?: string };
  transactions: { pay?: TxLink; settle?: TxLink; refund?: TxLink };
  /** Paying the merchant in THB. Only SUCCEEDED, with a reference, means the merchant was paid. */
  payout?: { status: PayoutStatus; provider: string; reference?: string };
  failureReason?: string;
  quoteExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TxLink {
  hash: Hex;
  url: string;
}

/** `txPath`: "tx" for Etherscan-style explorers (EVM rail), "txns" for nearblocks (NEAR rail). */
export function toPaymentView(
  { payment, quote: { quote }, payout }: PaymentWithQuote,
  explorerUrl: string,
  txPath = 'tx',
): PaymentView {
  const explorer = explorerUrl.replace(/\/$/, '');
  const link = (hash: Hex | undefined) => (hash ? { hash, url: `${explorer}/${txPath}/${hash}` } : undefined);
  const pay = link(payment.payTxHash);
  const settle = link(payment.settleTxHash);
  const refund = link(payment.refundTxHash);
  return {
    id: payment.id,
    quoteId: payment.quoteId,
    status: payment.status,
    fiatCurrency: quote.fiat.currency,
    fiatAmount: quote.fiat.minor.toString(),
    token: quote.token,
    tokenAmount: quote.tokenAmount.toString(),
    merchant: {
      kind: quote.merchant.kind,
      targetId: quote.merchant.targetId,
      ...(quote.merchant.merchantName === undefined ? {} : { name: quote.merchant.merchantName }),
    },
    transactions: {
      ...(pay ? { pay } : {}),
      ...(settle ? { settle } : {}),
      ...(refund ? { refund } : {}),
    },
    ...(payout
      ? {
          payout: {
            status: payout.status,
            provider: payout.provider,
            ...(payout.status === 'SUCCEEDED' && payout.providerReference ? { reference: payout.providerReference } : {}),
          },
        }
      : {}),
    ...(payment.failureReason === undefined ? {} : { failureReason: payment.failureReason }),
    quoteExpiresAt: quote.expiresAt.toISOString(),
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}
