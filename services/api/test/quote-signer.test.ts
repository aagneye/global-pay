import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { ViemQuoteSigner } from '../src/adapters/chain/viem-quote-signer.js';
import type { Quote } from '../src/domain/quote.js';
import { hashQuote, quoteTypedData } from '../src/lib/typed-data.js';
import { parsePromptPayQr } from '../src/lib/promptpay/parse.js';
import { ANVIL } from './support/anvil.js';

/**
 * Reference values from the real contract. On a fresh anvil (chain 31337) after
 * `forge script script/DeployLocal.s.sol --broadcast`:
 *
 *   cast call 0xe7f1…0512 "hashQuote((bytes32,address,address,uint256,bytes3,uint256,bytes32,uint64))(bytes32)" \
 *     "(0xabab…ab,0x15d3…6A65,0x5FbD…0aa3,3107693,0x544842,10000,<merchantRefHash>,1794500000)"
 *   cast wallet sign --private-key <anvil #2> --no-hash <digest>
 *
 * If the contract's EIP-712 encoding changes, regenerate these and update src/lib/typed-data.ts to match.
 */
const CONTRACT_DIGEST = '0xddcdf74dbbd76c3a8a442dc975c0a776300fbfdc9fa76f5afdfbdf1cc28b1706';
const CONTRACT_SIGNATURE =
  '0x18234c75b629528d54b875f83ddf06d8bd1b26bd694326d3bfcd1606f07001df4af943bea26903c774c4c2eb90f1612d1a4c0a1d3d30407f3cfbb8af85f0b60f1b';

const quote: Quote = {
  quoteId: `0x${'ab'.repeat(32)}`,
  payer: ANVIL.accounts.payer.address,
  token: ANVIL.usdc,
  tokenAmount: 3_107_693n,
  fiat: { currency: 'THB', minor: 10_000n },
  rateE8: 32_50000000n,
  spreadBps: 100,
  merchantRef: 'promptpay:biller:099999999999901',
  merchantRefHash: '0xf00693116400736b2592210681da6a3d56654b34f739487ff2dfd42ad12d0efc',
  merchant: parsePromptPayQr(
    '00020101021230600016A00000067701011201150999999999999010207INV00010306TABLE753037645406250.005802TH5919GLOBALPAY TEST CAFE6007BANGKOK6304E9FD',
  ),
  expiresAt: new Date(1_794_500_000 * 1000),
};

describe('quote EIP-712 encoding', () => {
  it('matches GlobalPaySettlement.hashQuote', () => {
    expect(hashQuote(quote, ANVIL.chainId, ANVIL.settlement)).toBe(CONTRACT_DIGEST);
  });

  it('changes when any signed field changes', () => {
    const variants: Quote[] = [
      { ...quote, tokenAmount: quote.tokenAmount + 1n },
      { ...quote, fiat: { currency: 'THB', minor: 10_001n } },
      { ...quote, expiresAt: new Date(1_794_500_001 * 1000) },
      { ...quote, payer: ANVIL.accounts.treasury.address },
    ];
    for (const variant of variants) {
      expect(hashQuote(variant, ANVIL.chainId, ANVIL.settlement)).not.toBe(CONTRACT_DIGEST);
    }
    expect(hashQuote(quote, 84532, ANVIL.settlement)).not.toBe(CONTRACT_DIGEST);
  });
});

describe('ViemQuoteSigner', () => {
  const signer = new ViemQuoteSigner({
    privateKey: ANVIL.accounts.quoteSigner.privateKey,
    chainId: ANVIL.chainId,
    settlementAddress: ANVIL.settlement,
  });

  it('produces the same signature as the contract-side reference', async () => {
    expect(signer.address).toBe(ANVIL.accounts.quoteSigner.address);
    const signature = await signer.sign(quote);
    expect(signature).toBe(CONTRACT_SIGNATURE);
    await expect(
      recoverTypedDataAddress({ ...quoteTypedData(quote, ANVIL.chainId, ANVIL.settlement), signature }),
    ).resolves.toBe(ANVIL.accounts.quoteSigner.address);
  });

  it('fails with 503 when the key or settlement address is missing', async () => {
    const noKey = new ViemQuoteSigner({ chainId: ANVIL.chainId, settlementAddress: ANVIL.settlement });
    const noContract = new ViemQuoteSigner({
      chainId: ANVIL.chainId,
      privateKey: ANVIL.accounts.quoteSigner.privateKey,
    });
    expect(() => noKey.address).toThrow(/QUOTE_SIGNER_PRIVATE_KEY/);
    await expect(noContract.sign(quote)).rejects.toMatchObject({ code: 'not_configured', statusCode: 503 });
  });
});
