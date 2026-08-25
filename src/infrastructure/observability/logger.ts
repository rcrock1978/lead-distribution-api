import { pino, type Logger as PinoLogger } from 'pino';

import type { Env } from '../../config/env';
import type { EventName } from './events';

/**
 * pino behind a typed wrapper (research D6): newline-delimited JSON to stdout,
 * serializer-level redaction so careless spreads are safe, child loggers bind
 * requestId + traceId (Constitution IV).
 */

const REDACT_PATHS = [
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'authorization',
  'cookie',
  'token',
  'DATABASE_URL',
];

/** Mask emails: "jane.doe@example.com" → "j***e@d***.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***${local[local.length - 1] ?? ''}@${domain[0]}***${tld}`;
}

const isoTs = (): string => `,"ts":"${new Date(Date.now()).toISOString()}"`;

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(event: EventName, msg?: string, fields?: Record<string, unknown>): void;
  warn(event: EventName, msg?: string, fields?: Record<string, unknown>): void;
  error(event: EventName, msg?: string, fields?: Record<string, unknown>): void;
  debug(event: EventName, msg?: string, fields?: Record<string, unknown>): void;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.inner.child(bindings));
  }

  private emit(
    level: 'info' | 'warn' | 'error' | 'debug',
    event: EventName,
    msg: string | undefined,
    fields?: Record<string, unknown>,
  ): void {
    this.inner[level]({ event, ...(fields ?? {}) }, msg ?? event);
  }

  info(e: EventName, m?: string, f?: Record<string, unknown>): void {
    this.emit('info', e, m, f);
  }
  warn(e: EventName, m?: string, f?: Record<string, unknown>): void {
    this.emit('warn', e, m, f);
  }
  error(e: EventName, m?: string, f?: Record<string, unknown>): void {
    this.emit('error', e, m, f);
  }
  debug(e: EventName, m?: string, f?: Record<string, unknown>): void {
    this.emit('debug', e, m, f);
  }
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, processName: string): Logger {
  const inner = pino({
    level: env.LOG_LEVEL,
    timestamp: isoTs,
    base: { process: processName },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
  return new PinoLoggerAdapter(inner);
}
