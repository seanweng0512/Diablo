/**
 * Minimal leveled logger.
 *
 * Everything goes to stderr so that stdout stays clean for the CLI interaction
 * provider, which uses it to talk to the user.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function resolveLevel(): LogLevel {
  const raw = (process.env.BRIDGE_LOG_LEVEL ?? 'info').toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'info';
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, extra?: unknown): void {
  if (RANK[level] < RANK[currentLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (extra === undefined) {
    process.stderr.write(`${line}\n`);
    return;
  }
  const detail =
    extra instanceof Error
      ? (extra.stack ?? `${extra.name}: ${extra.message}`)
      : safeStringify(extra);
  process.stderr.write(`${line} ${detail}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
