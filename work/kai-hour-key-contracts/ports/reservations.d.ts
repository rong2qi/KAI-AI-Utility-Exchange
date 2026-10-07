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
