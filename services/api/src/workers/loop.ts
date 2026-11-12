import type { FastifyBaseLogger } from 'fastify';

export type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

/**
 * Runs `tick` every `intervalMs`, one tick at a time: the next waits for the previous to finish.
 * A failing tick is logged and the loop carries on.
 */
export class PollingLoop {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
  ) {}

  start(log: WorkerLogger): void {
    if (this.running) return;
    this.running = true;
    const run = async (): Promise<void> => {
      if (!this.running) return;
      this.current = this.tick().catch((error: unknown) => log.error({ err: error, worker: this.name }, 'tick failed'));
      await this.current;
      if (this.running) this.timer = setTimeout(() => void run(), this.intervalMs);
    };
    log.info({ worker: this.name, intervalMs: this.intervalMs }, 'worker started');
    void run();
  }

  /** Stops the loop and waits for a tick in progress to finish. */
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.current;
  }
}
