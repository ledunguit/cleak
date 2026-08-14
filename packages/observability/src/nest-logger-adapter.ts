import type { LoggerService, LogLevel } from '@nestjs/common';
import type pino from 'pino';

const STACK_RE = /^(.)+\n\s+at .+:\d+:\d+/;
type PinoLevel = 'info' | 'warn' | 'debug' | 'trace' | 'fatal' | 'error';

/** Mirrors Nest's own `ConsoleLogger.getContextAndMessagesToPrint` exactly: the
 * last arg, if a string, is the per-instance `context` (the class name from
 * `new Logger(ClassName.name)`) — everything else is message data. */
function splitContext(args: unknown[]): { messages: unknown[]; context?: string } {
  if (args.length <= 1) return { messages: args };
  const last = args[args.length - 1];
  if (typeof last !== 'string') return { messages: args };
  return { context: last, messages: args.slice(0, -1) };
}

/** Mirrors `ConsoleLogger.getContextAndStackAndMessagesToPrint`: after splitting
 * off `context`, a remaining trailing string that LOOKS like an Error stack
 * trace is split off as `stack` rather than treated as the log message. */
function splitContextAndStack(args: unknown[]): { messages: unknown[]; context?: string; stack?: string } {
  const { messages, context } = splitContext(args);
  if (messages.length <= 1) return { messages, context };
  const last = messages[messages.length - 1];
  if (typeof last === 'string' && STACK_RE.test(last)) {
    return { stack: last, messages: messages.slice(0, -1), context };
  }
  return { messages, context };
}

function joinMessages(messages: unknown[]): string | undefined {
  if (!messages.length) return undefined;
  return messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
}

function isPlainFieldsObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !(v instanceof Error) && !Array.isArray(v);
}

/**
 * Adapts pino to NestJS's `LoggerService` interface so `ctx.useLogger(new
 * PinoNestLogger(root))` upgrades every existing `new Logger(ClassName.name)`
 * call site in both analyzer apps to structured, request-context-tagged JSON
 * with ZERO changes at those call sites — `nest.Logger` already appends the
 * class-name `context` as the trailing argument on every call (see split
 * helpers above), which becomes pino's `service` field.
 *
 * Supports TWO call styles, both legal under Nest's `LoggerService` (`message:
 * any`): the plain-string style already used at the 7 existing call sites
 * (`logger.log('adapted build command…')`), and a structured style for new
 * instrumentation that wants real JSON fields instead of embedding them in
 * text — `logger.log({event: ServerEventName.BUILD_STARTED, projectPath}, 'build
 * started')` — the first arg becomes top-level pino fields (`event`,
 * `projectPath`, …), the rest become the human-readable `msg`.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly root: pino.Logger) {}

  private childFor(context?: string): pino.Logger {
    return context ? this.root.child({ service: context }) : this.root;
  }

  private emit(level: PinoLevel, messages: unknown[], context?: string, extraFields?: Record<string, unknown>): void {
    const logger = this.childFor(context);
    const [first, ...rest] = messages;
    if (isPlainFieldsObject(first)) {
      logger[level]({ ...first, ...extraFields }, joinMessages(rest));
    } else if (extraFields) {
      logger[level](extraFields, joinMessages(messages));
    } else {
      logger[level](joinMessages(messages) ?? '');
    }
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context } = splitContext([message, ...optionalParams]);
    this.emit('info', messages, context);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context, stack } = splitContextAndStack([message, ...optionalParams]);
    this.emit('error', messages, context, stack ? { stack } : undefined);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context } = splitContext([message, ...optionalParams]);
    this.emit('warn', messages, context);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context } = splitContext([message, ...optionalParams]);
    this.emit('debug', messages, context);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context } = splitContext([message, ...optionalParams]);
    this.emit('trace', messages, context);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    const { messages, context } = splitContext([message, ...optionalParams]);
    this.emit('fatal', messages, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    // Nest's most-verbose-enabled level maps onto pino's single `level` threshold.
    const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
    const pinoLevel: Record<LogLevel, PinoLevel> = {
      verbose: 'trace',
      debug: 'debug',
      log: 'info',
      warn: 'warn',
      error: 'error',
      fatal: 'fatal',
    };
    const mostVerbose = order.find((l) => levels.includes(l));
    if (mostVerbose) this.root.level = pinoLevel[mostVerbose];
  }
}
