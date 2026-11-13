import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACTS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../contracts');

/**
 * Finds a Foundry binary: $FOUNDRY_BIN, then ~/.foundry/bin (where foundryup installs), then PATH.
 * On PATH, `forge` must really be Foundry's: other tools use the same name.
 */
export function findFoundryBin(name: 'anvil' | 'forge'): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of [process.env.FOUNDRY_BIN, join(homedir(), '.foundry', 'bin')]) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  try {
    const version = execFileSync(name, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return version.includes(`${name} Version`) ? name : null;
  } catch {
    return null;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
}

export interface Anvil {
  rpcUrl: string;
  stop(): void;
}

/**
 * Starts anvil (automine) on a free port and waits until it answers: a fresh chain 31337 by default,
 * or a fork with e.g. `['--fork-url', url, '--chain-id', '84532']`.
 */
export async function startAnvil(bin: string, extraArgs: string[] = []): Promise<Anvil> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(bin, ['--port', String(port), '--silent', ...extraArgs], { stdio: 'ignore' });

  const deadline = Date.now() + (extraArgs.includes('--fork-url') ? 90_000 : 20_000);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) return { rpcUrl, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`anvil did not start on ${rpcUrl}`);
}

/**
 * Runs contracts/script/DeployLocal.s.sol: mock USDC and the settlement contract at their fixed
 * addresses (test/support/anvil.ts), roles assigned, test payer funded.
 */
export function deployLocal(forge: string, rpcUrl: string): void {
  try {
    execFileSync(forge, ['script', 'script/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast'], {
      cwd: CONTRACTS_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`DeployLocal failed:\n${stdout ?? ''}\n${stderr ?? ''}`);
  }
}

/**
 * Runs the real contracts/script/Deploy.s.sol with the given settings (as in contracts/.env).
 * Its broadcast record goes to `broadcastDir`, never to contracts/broadcast, where real testnet
 * deployments are recorded. Returns the forge output.
 */
export function deployScript(forge: string, rpcUrl: string, env: Record<string, string>, broadcastDir: string): string {
  try {
    return execFileSync(forge, ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast'], {
      cwd: CONTRACTS_DIR,
      encoding: 'utf8',
      env: { ...process.env, ...env, FOUNDRY_BROADCAST: broadcastDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`Deploy.s.sol failed:
${stdout ?? ''}
${stderr ?? ''}`);
  }
}
