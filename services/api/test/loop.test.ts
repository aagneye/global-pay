import { describe, expect, it, vi } from 'vitest';
import { PollingLoop, type WorkerLogger } from '../src/workers/loop.js';

const logger = (): WorkerLogger & { error: ReturnType<typeof vi.fn> } =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;

describe('PollingLoop', () => {
  it('runs ticks one after another until stopped, surviving a failing tick', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const loop = new PollingLoop('test', 5, async () => {
      calls++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      if (calls === 2) throw new Error('boom');
    });
    const log = logger();

    loop.start(log);
    loop.start(log); // a second start is ignored
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4), { timeout: 2_000 });
    await loop.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 40));

    expect(calls).toBe(after);
    expect(maxConcurrent).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ worker: 'test' }), 'tick failed');
  });

  it('waits for the tick in progress when stopping', async () => {
    let finished = false;
    const loop = new PollingLoop('test', 1_000, async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
    });
    loop.start(logger());
    await loop.stop();
    expect(finished).toBe(true);
  });
});
