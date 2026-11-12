/**
 * Prints test PromptPay QR payloads to scan or paste during the demo. All IDs are fake.
 *
 *   npm run qr:make             merchant QR for 100.00 THB, plus the other demo QRs
 *   npm run qr:make -- 250.50   merchant QR for 250.50 THB
 */
import { FIAT_DECIMALS, formatMinor, parseDecimal } from '../src/domain/money.js';
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';

const amountArg = process.argv[2] ?? '100.00';
const minor = parseDecimal(amountArg, FIAT_DECIMALS.THB);
if (minor === null || minor <= 0n) {
  console.error(`Not a valid THB amount: ${amountArg}`);
  process.exit(1);
}

const cafe = {
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  reference1: 'DEMO0001',
  merchantName: 'GLOBALPAY TEST CAFE',
  merchantCity: 'BANGKOK',
} as const;

const qrs: [string, string][] = [
  [
    `Merchant, ${formatMinor(minor, FIAT_DECIMALS.THB)} THB`,
    buildPromptPayQr({ ...cafe, amount: { currency: 'THB', minor } }),
  ],
  ['Merchant, no amount (the app asks for one)', buildPromptPayQr(cafe)],
  [
    'Personal mobile, 50.00 THB (refused when MERCHANT_QR_ONLY=true)',
    buildPromptPayQr({
      kind: 'personal',
      targetType: 'mobile',
      targetId: '0066812345678',
      amount: { currency: 'THB', minor: 50_00n },
    }),
  ],
];

for (const [label, payload] of qrs) {
  console.log(`${label}:\n${payload}\n`);
}
