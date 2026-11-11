/**
 * Prints test PromptPay QR payloads to scan during the demo.
 * Usage: npm run qr:make (works from iteration 3, when the builder is implemented).
 */
import { buildPromptPayQr } from '../src/lib/promptpay/build.js';

const payload = buildPromptPayQr({
  kind: 'merchant',
  targetType: 'biller',
  targetId: '099999999999901',
  reference1: 'DEMO0001',
  amount: { currency: 'THB', minor: 100_00n },
  merchantName: 'GLOBALPAY TEST CAFE',
  merchantCity: 'BANGKOK',
});

console.log(payload);
