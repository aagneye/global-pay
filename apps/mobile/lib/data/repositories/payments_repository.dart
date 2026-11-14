import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/domain/models/money.dart';
import 'package:globalpay/domain/models/payment.dart';
import 'package:globalpay/domain/models/quote.dart';

const usdcDecimals = 6;

/// Quote -> sign -> submit -> poll (POST /quotes, POST /payments, GET /payments/:id).
class PaymentsRepository {
  const PaymentsRepository({required this.api});

  final ApiClient api;

  /// [fiatAmountMinor] (THB satang) is required when the QR has no amount.
  Future<Quote> requestQuote({required String payer, required String qrPayload, BigInt? fiatAmountMinor}) async {
    final response = await ApiClient.call(
      () => api.api.quotes.createQuote(
        body: dto.QuoteRequest(payer: payer, qrPayload: qrPayload, fiatAmountMinor: fiatAmountMinor?.toString()),
      ),
    );
    return quoteFromDto(response);
  }

  /// Sends the wallet's signature over [Quote.authorization]. The payment starts as SUBMITTED.
  Future<Payment> submit(Quote quote, String signature) async {
    final response = await ApiClient.call(
      () => api.api.payments.submitPayment(
        body: dto.PaymentRequest(
          quoteId: quote.quoteId,
          validAfter: quote.authorization.validAfter,
          validBefore: quote.authorization.validBefore,
          signature: signature,
        ),
      ),
    );
    return paymentFromDto(response);
  }

  Future<Payment> get(String paymentId) async =>
      paymentFromDto(await ApiClient.call(() => api.api.payments.getPayment(id: paymentId)));
}

TokenAmount usdc(String units) => TokenAmount(symbol: 'USDC', units: BigInt.parse(units), decimals: usdcDecimals);

FiatAmount thb(String minor) => FiatAmount(currency: FiatCurrency.thb, minor: BigInt.parse(minor));

Quote quoteFromDto(dto.QuoteResponse response) {
  final typed = response.authorizationToSign!;
  return Quote(
    quoteId: response.quote.quoteId,
    payer: response.quote.payer,
    token: response.quote.token,
    tokenAmount: usdc(response.quote.tokenAmount),
    feeAmount: usdc(response.pricing.feeTokenAmount),
    fiatAmount: thb(response.quote.fiatAmount),
    rateE8: BigInt.parse(response.pricing.rateE8),
    spreadBps: response.pricing.spreadBps,
    merchant: QuoteMerchant(
      isMerchant: response.merchant.kind == dto.QuoteMerchantKind.merchant,
      targetId: response.merchant.targetId,
      name: response.merchant.merchantName,
      city: response.merchant.merchantCity,
      reference: response.merchant.reference1,
    ),
    expiresAt: response.expiresAt,
    authorization: AuthorizationToSign(
      // The exact eth_signTypedData_v4 payload the backend checks the signature against.
      typedData: {
        'types': {
          for (final entry in typed.types.entries)
            entry.key: [
              for (final field in entry.value) {'name': field.name, 'type': field.type},
            ],
        },
        // Null for a type this app doesn't know, which the signing check refuses.
        'primaryType': typed.primaryType.json,
        'domain': typed.domain.toJson(),
        'message': typed.message.toJson(),
      },
      validAfter: typed.message.validAfter,
      validBefore: typed.message.validBefore,
    ),
  );
}

Payment paymentFromDto(dto.Payment response) {
  TxLink? link(dto.TxLink? tx) => tx == null ? null : TxLink(hash: tx.hash, url: tx.url);
  return Payment(
    id: response.id,
    quoteId: response.quoteId,
    status: PaymentStatus.fromApi(response.status.toJson()),
    fiatAmount: thb(response.fiatAmount),
    tokenAmount: usdc(response.tokenAmount),
    merchantName: response.merchant.name ?? 'PromptPay ${response.merchant.targetId}',
    createdAt: response.createdAt,
    failureReason: response.failureReason,
    payTx: link(response.transactions.pay),
    settleTx: link(response.transactions.settle),
    refundTx: link(response.transactions.refund),
    payout: switch (response.payout) {
      null => null,
      final payout => Payout(
        status: PayoutStatus.fromApi(payout.status.json),
        provider: payout.provider,
        reference: payout.reference,
      ),
    },
  );
}
