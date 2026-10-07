import type { HourKeyRuntimePort } from './runtime.js';

/** Local-only transport. These types document the port; runtime validation remains mandatory. */
export interface ExchangeServerOptions {
  readonly runtime: HourKeyRuntimePort;
  readonly host?: '127.0.0.1';
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly maxConcurrentRequests?: number;
}

export interface ExchangeServerPort {
  listen(): Promise<void>;
  address(): string | undefined;
  /** Stops accepting connections; does not claim cancellation of already-running Provider work. */
  close(): Promise<void>;
}
