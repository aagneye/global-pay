import type { Address, Hex } from 'viem';
import { NotImplementedError } from '../../shared/errors.js';

export interface AuthServiceDeps {
  jwtSecret: string;
  chainId: number;
}

/** Sign-In with Ethereum (EIP-4361): one-time nonce → signed message → JWT. */
export class AuthService {
  private readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  async createNonce(_address: Address): Promise<{ nonce: string; expiresAt: Date }> {
    throw new NotImplementedError('SIWE nonce', 3);
  }

  async verify(_message: string, _signature: Hex): Promise<{ token: string; userId: string }> {
    throw new NotImplementedError('SIWE verify', 3);
  }
}
