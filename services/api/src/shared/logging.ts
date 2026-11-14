import type { FastifyBaseLogger } from 'fastify';
import { LOG_REDACT_PATHS, REDACTED, scrubError, scrubText } from './redact.js';

/** Where logs go: stdout by default, or a stream (tests read one). */
export interface LogDestination {
  stream?: { write(line: string): void };
  level?: string;
}

/**
 * pino settings for the app's logger, so nothing secret or personal is written:
 * - fields named like secrets are redacted (`redact`);
 * - errors (`err`) are scrubbed in full: secret fields at any depth, keys and signatures in their text, their causes;
 * - log messages are scrubbed too. pino uses an error's message as the log message when it's logged on its own.
 * Logs are the error report: ship level ≥ 50 (error, fatal) from stdout to any error tracker.
 */
export function loggerOptions(logger: boolean | LogDestination) {
  if (logger === false) return false;
  const { stream, level = 'info' } = logger === true ? {} : logger;
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    serializers: { err: scrubError },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void) {
        if (args.length === 0) return method.apply(this, args);
        const first = args[0] instanceof Error ? { err: args[0] } : args[0];
        let rest = args.slice(1);
        // Without a message, pino would use the error's message as it is.
        const err = typeof first === 'object' && first !== null ? (first as { err?: unknown }).err : undefined;
        if (err instanceof Error && typeof rest[0] !== 'string') rest = [err.message, ...rest];
        return method.apply(this, [first, ...rest].map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg)));
      },
    },
  };
}

type Exit = (code: number) => void;

/**
 * Last-resort handlers for errors nothing caught. Both are logged through `log`, whose serializer scrubs them.
 * - An uncaught exception leaves the process in an unknown state: log it, then exit 1 so the supervisor restarts it.
 *   Workers resume from the database and the chain.
 * - An unhandled promise rejection is logged and the server keeps running.
 */
export function installCrashHandlers(
  log: Pick<FastifyBaseLogger, 'fatal' | 'error'>,
  exit: Exit = (code) => process.exit(code),
  target: NodeJS.EventEmitter = process,
): void {
  target.on('uncaughtException', (error: unknown, origin: unknown) => {
    log.fatal({ err: error, origin }, 'uncaught exception; exiting');
    exit(1);
  });
  target.on('unhandledRejection', (reason: unknown) => {
    log.error({ err: reason }, 'unhandled promise rejection');
  });
}
