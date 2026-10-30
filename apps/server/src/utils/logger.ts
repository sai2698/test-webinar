/**
 * Tiny structured logger. Keeps output readable in dev and JSON-ish in prod
 * without pulling in a dependency.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  const tag = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  const line = `${ts} ${tag} [${scope}] ${msg}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line, extra ?? '');
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export const logger = createLogger('app');
