import type { Holding, Offer, PolicyDecision, RequestedResource, UsageReceipt } from '../types/index.js';
import type { RuntimeError } from '../types/errors.js';

export interface RuntimeRequest {
  readonly requestId: string;
  readonly opaqueKey: string;
  readonly userText: string;
  readonly requestedResource?: RequestedResource;
  readonly holdingId?: string;
  readonly offerId?: string;
  readonly receiptId?: string;
  /** Transport requires at least eight characters; Runtime validates the same minimum. */
  readonly idempotencyKey?: string;
  /** Required for lock side effects; discovery and compute ignore it. */
  readonly confirmed?: boolean;
  readonly providerInput?: unknown;
}

export type RuntimeResponse =
  | { readonly kind: 'policy'; readonly decision: PolicyDecision }
  | { readonly kind: 'offers'; readonly offers: readonly Offer[]; readonly decision: PolicyDecision }
  | { readonly kind: 'holding'; readonly holding: Holding; readonly decision: PolicyDecision }
  | {
      readonly kind: 'receipt';
      readonly receipt: UsageReceipt;
      /** Present for Compute only; private model output is never part of the Receipt. */
      readonly output?: unknown;
      readonly decision: PolicyDecision;
    }
  | { readonly kind: 'error'; readonly error: RuntimeError };

/** Single application seam. It owns orchestration; adapters remain replaceable. */
export interface HourKeyRuntimePort {
  handle(request: RuntimeRequest): Promise<RuntimeResponse>;
}
