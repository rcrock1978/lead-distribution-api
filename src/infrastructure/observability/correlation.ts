import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  traceId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 16-byte hex = exactly 32 chars, matching Lead.traceId CHAR(32). */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Runs `handler` inside an explicit correlation context. Used by the API
 * middleware per request and by the worker around each message so a single
 * traceId spans processes and async boundaries (Constitution IV).
 */
export function runWithCorrelation<T>(ctx: RequestContext, handler: () => T): T {
  return storage.run(ctx, handler);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireTraceId(): string {
  return currentContext()?.traceId ?? newTraceId();
}
