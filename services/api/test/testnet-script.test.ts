import { describe, expect, it } from 'vitest';
import { readDeployment, setEnvValue } from '../scripts/testnet.js';

describe('testnet script', () => {
  it('sets a value in place, leaving comments and commented-out lines alone', () => {
    const text = '# Keys\n# RELAYER_PRIVATE_KEY=0xlocal\nRELAYER_PRIVATE_KEY=\nCHAIN_ID=84532\n';
    expect(setEnvValue(text, 'RELAYER_PRIVATE_KEY', '0xabc')).toBe(
      '# Keys\n# RELAYER_PRIVATE_KEY=0xlocal\nRELAYER_PRIVATE_KEY=0xabc\nCHAIN_ID=84532\n',
    );
  });

  it('appends a missing value, with an optional comment', () => {
    expect(setEnvValue('A=1', 'B', '2', 'Why B')).toBe('A=1\n\n# Why B\nB=2\n');
    expect(setEnvValue('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
  });

  it('reads the settlement address and block from a broadcast record', () => {
    const record = {
      transactions: [
        { transactionType: 'CREATE', contractName: 'GlobalPaySettlement', contractAddress: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', hash: '0x01' },
        { transactionType: 'CALL', contractName: 'GlobalPaySettlement', hash: '0x02' },
      ],
      receipts: [
        { transactionHash: '0x02', blockNumber: '0x10' },
        { transactionHash: '0x01', blockNumber: '0x37a8f2c' },
      ],
    };
    expect(readDeployment(record)).toEqual({ address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', block: 58363692n });
    expect(() => readDeployment({ transactions: [] })).toThrow(/No GlobalPaySettlement/);
    expect(() => readDeployment({ transactions: record.transactions, receipts: [] })).toThrow(/no receipt/);
  });
});
