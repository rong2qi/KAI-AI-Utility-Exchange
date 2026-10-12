import type { Holding, IsoDateTime, UsageReceipt } from '../types/index.js';
import type { ProviderExecutionResult, UsageExecutionBinding } from './index.js';

export type ReservationState = 'reserved' | 'dispatching' | 'provider_succeeded' | 'uncertain' | 'committed' | 'receipt_prepared' | 'receipt_committed' | 'released';

export interface ReservationEntry {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly binding: UsageExecutionBinding;
  readonly units: number;
  readonly state: ReservationState;
  readonly ownerToken: string;
  readonly reservedAt: IsoDateTime;
  readonly providerResult?: ProviderExecutionResult;
  readonly holding?: Holding;
  readonly receipt?: UsageReceipt;
}

export interface ReserveCommand {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly binding: UsageExecutionBinding;
  readonly units: number;
  readonly at: IsoDateTime;
  readonly ownerToken: string;
}

export interface MoveReservationCommand {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly ownerToken: string;
  readonly from: ReservationState;
  readonly to: ReservationState;
  readonly providerResult?: ProviderExecutionResult;
  readonly receipt?: UsageReceipt;
}

export interface ReservationSnapshot {
  readonly schema: 'kai-reservation-store.v1';
  readonly holdings: readonly Holding[];
  readonly totals: readonly { readonly accountId: string; readonly holdingId: string; readonly total: number; readonly reserved: number }[];
  readonly entries: readonly ReservationEntry[];
}

export interface ReservationStorePort {
  reserve(command: ReserveCommand): Promise<{ readonly acquired: boolean; readonly entry: ReservationEntry }>;
  move(command: MoveReservationCommand): Promise<ReservationEntry>;
  getHolding(accountId: string, holdingId: string): Promise<Holding | undefined>;
  inspect(accountId: string, holdingId: string): Promise<{ readonly total: number; readonly available: number; readonly reserved: number; readonly committed: number }>;
}

/** Optional recovery extension. Ordinary reservation adapters keep the original interface. */
export interface ReservationRecoveryStorePort extends ReservationStorePort {
  getReservation(accountId: string, idempotencyKey: string): Promise<ReservationEntry | undefined>;
}

export type SettlementRecoveryResult =
  | { readonly status: 'settled'; readonly receipt: UsageReceipt; readonly output: unknown }
  | { readonly status: 'pending_reconciliation'; readonly reason: 'ADMISSION_NOT_RESOLVED' | 'PROVIDER_OUTCOME_NOT_RECORDED' }
  | { readonly status: 'released' }
  | { readonly status: 'error'; readonly code: import('../types/errors.js').RuntimeErrorCode };

/** Does not accept Provider execution, a new input or a client-supplied outcome. */
export interface SettlementRecoveryPort {
  recover(request: { readonly opaqueKey: string; readonly idempotencyKey: string }): Promise<SettlementRecoveryResult>;
}
