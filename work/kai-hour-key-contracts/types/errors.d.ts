export type RuntimeErrorCode =
  | 'KEY_INVALID'
  | 'KEY_EXPIRED'
  | 'KEY_REVOKED'
  | 'SCOPE_EXPANSION_REQUIRED'
  | 'CAPABILITY_DENIED'
  | 'SLOT_NOT_ACTIVE'
  | 'LOCK_DEADLINE_CLOSED'
  | 'OFFER_STALE'
  | 'HOLDING_EXHAUSTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SOURCE_URL_UNTRUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'REQUEST_INVALID'
  | 'HOLDING_REQUIRED'
  | 'RECEIPT_NOT_FOUND'
  | 'CATALOG_UNAVAILABLE'
  | 'OFFER_NOT_FOUND'
  | 'HOUR_KEY_PACKAGING_FAILED'
  | 'HOLDING_LOCK_FAILED'
  | 'RECEIPT_WRITE_FAILED'
  | 'EXECUTION_LEDGER_FAILED'
  | 'AUTHORIZATION_EXPIRED'
  | 'ROUTE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'REQUEST_TIMEOUT'
  | 'EXECUTION_TIMEOUT'
  | 'EXCHANGE_BUSY'
  | 'INTERNAL_ERROR'
  | 'EXECUTION_IN_PROGRESS'
  | 'EXECUTION_UNCERTAIN'
  | 'EXECUTION_RELEASED';


export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly requiredScope?: Readonly<{
    readonly models?: readonly string[];
    readonly providers?: readonly string[];
    readonly regions?: readonly string[];
  }>;
}
