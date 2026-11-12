import type { Address, Hex } from 'viem';

/**
 * Anvil's default test accounts and the addresses `contracts/script/DeployLocal.s.sol`
 * deploys to on a fresh anvil. These keys are public: use them on a local chain only.
 */
export const ANVIL = {
  chainId: 31337,
  usdc: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address,
  settlement: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address,
  accounts: {
    treasury: {
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
    },
    quoteSigner: {
      address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
      privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
    },
    payer: {
      address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address,
      privateKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex,
    },
  },
} as const;
