/**
 * Checks a Xendit **test-mode** account against our payout adapter. Refuses live keys.
 *
 *   XENDIT_SECRET_KEY=xnd_development_… npm run xendit:sandbox
 *       THB balance, and the THB payout channels (pick XENDIT_PROMPTPAY_CHANNEL from these)
 *
 *   XENDIT_SECRET_KEY=xnd_development_… npm run xendit:sandbox -- pay <channelCode> <accountNumber> <amountTHB>
 *       one test payout through XenditPayoutProvider, polled until it's final, then found again by
 *       its idempotency key (the lookup the worker does before any retry)
 *
 * No money moves in test mode. Xendit's docs list test account numbers that force each outcome.
 */
import { XenditPayoutProvider } from '../src/adapters/payouts/xendit-provider.js';
import { FIAT_DECIMALS, formatMinor, parseDecimal } from '../src/domain/money.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';
import { parsePromptPayQr } from '../src/lib/promptpay/parse.js';

const secretKey = process.env.XENDIT_SECRET_KEY ?? '';
const baseUrl = process.env.XENDIT_BASE_URL ?? 'https://api.xendit.co';
if (!secretKey.startsWith('xnd_development_')) {
  console.error('Set XENDIT_SECRET_KEY to a Xendit TEST key (xnd_development_…). Live keys are refused.');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

async function overview(): Promise<void> {
  const provider = new XenditPayoutProvider({ secretKey, baseUrl });
  const balance = await provider.getBalance();
  console.log(`THB balance: ${balance ? formatMinor(balance.minor, FIAT_DECIMALS.THB) : 'not reported'}`);

  const response = await fetch(`${baseUrl}/payouts_channels?currency=THB`, { headers: { authorization: auth } });
  if (!response.ok) throw new Error(`payouts_channels: HTTP ${response.status} ${await response.text()}`);
  const channels = (await response.json()) as { channel_code: string; channel_name?: string; channel_category?: string }[];
  console.log(`\nTHB payout channels (${channels.length}):`);
  for (const channel of channels) {
    console.log(`  ${channel.channel_code.padEnd(24)} ${channel.channel_category ?? ''}  ${channel.channel_name ?? ''}`);
  }
}

async function pay(channelCode: string, accountNumber: string, amountArg: string): Promise<void> {
  const minor = parseDecimal(amountArg, FIAT_DECIMALS.THB);
  if (minor === null || minor <= 0n) throw new Error(`Not a valid THB amount: ${amountArg}`);

  // A demo biller QR, sent to the given test account through PAYOUT_TEST_DESTINATIONS' mechanism.
  const targetId = '099999999999901';
  const merchant = parsePromptPayQr(buildPromptPayQr({ kind: 'merchant', targetType: 'biller', targetId }));
  const provider = new XenditPayoutProvider({
    secretKey,
    baseUrl,
    testDestinations: { [targetId]: { channelCode, accountNumber, accountHolderName: 'GlobalPay sandbox' } },
  });
  const key = `sandbox-${Date.now()}`;

  let result = await provider.createPayout({
    idempotencyKey: key,
    paymentId: key,
    merchant,
    amount: { currency: 'THB', minor },
  });
  console.log(`create → ${result.status} ${result.providerStatus ?? ''} ${result.providerRef ?? ''}`);

  const deadline = Date.now() + 120_000;
  while (result.status === 'pending' && result.providerRef && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    result = await provider.getPayout(result.providerRef);
    console.log(`check  → ${result.status} ${result.providerStatus ?? ''}`);
  }
  console.log('\nFinal:', JSON.stringify({ ...result, raw: undefined }, null, 2));

  const found = await provider.findByIdempotencyKey(key);
  console.log(`\nLookup by idempotency key → ${found ? `${found.status} ${found.providerRef ?? ''}` : 'not found'}`);
}

const [command, ...args] = process.argv.slice(2);
const run =
  command === 'pay' && args.length === 3
    ? pay(args[0]!, args[1]!, args[2]!)
    : command === undefined
      ? overview()
      : Promise.reject(new Error('Usage: xendit-sandbox.ts [pay <channelCode> <accountNumber> <amountTHB>]'));
run.catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
