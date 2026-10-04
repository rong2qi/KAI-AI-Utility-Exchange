import type {
  AccountId,
  AuthorizationGrant,
  Holding,
  HourKeyEnvelope,
  IsoDateTime,
  Offer,
  OfferId,
  PolicyDecision,
  ResourceScope,
  UsageReceipt,
} from '../types/index.js';

export interface KeyVerification {
  readonly key: HourKeyEnvelope;
  readonly grants: readonly AuthorizationGrant[];
}

export interface KeyVerifierPort {
  verify(opaqueKey: string, at: IsoDateTime): Promise<KeyVerification>;
}

export interface OfferQuery {
  readonly accountId: AccountId;
  readonly requestedResource?: Partial<ResourceScope>;
  readonly at: IsoDateTime;
}

export interface OfferCatalogPort {
  readonly mode: 'market_data' | 'transactional';
  query(query: OfferQuery): Promise<readonly Offer[]>;
  get(offerId: OfferId): Promise<Offer | undefined>;
}

export interface HourKeyPackagingCommand {
  readonly accountId: AccountId;
  readonly offer: Offer;
  readonly idempotencyKey: string;
}

export interface HourKeyPackagingStoreCommand {
  readonly accountId: AccountId;
  readonly offer: Offer;
  readonly idempotencyKey: string;
}

/** Atomic persistence boundary for packaged Offers. */
export interface HourKeyPackagingStorePort {
  get(accountId: AccountId, idempotencyKey: string): Promise<Offer | undefined>;
  getOrCreate(command: HourKeyPackagingStoreCommand): Promise<Offer>;
}

/** Converts a real market Offer into a KAI Hour Key Offer without changing market truth. */
export interface HourKeyPackagingPort {
  package(command: HourKeyPackagingCommand): Promise<Offer>;
}

export interface HoldingPort {
  getCurrent(accountId: AccountId, at: IsoDateTime): Promise<Holding | undefined>;
  get(accountId: AccountId, holdingId: string): Promise<Holding | undefined>;
  /** Implementations must bind a returned Holding to the command account, grant, and Offer. */
  lock(command: LockHoldingCommand): Promise<Holding>;
  /** Implementations must enforce the Holding's active slot and idempotent consumption. */
  consume(command: ConsumeHoldingCommand): Promise<Holding>;
}

export interface LockHoldingCommand {
  readonly accountId: AccountId;
  readonly grantId: string;
  readonly offerId: OfferId;
  readonly at: IsoDateTime;
  readonly idempotencyKey: string;
}

export interface ConsumeHoldingCommand {
  readonly accountId: AccountId;
  readonly holdingId: string;
  readonly units: number;
  readonly at: IsoDateTime;
  readonly idempotencyKey: string;
}

export interface ProviderExecutionRequest {
  readonly model: string;
  readonly region: string;
  readonly input: unknown;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface ProviderExecutionResult {
  readonly providerRequestId: string;
  readonly output: unknown;
  readonly usage: { readonly inputUnits: number; readonly outputUnits: number; readonly totalUnits: number };
  readonly status: 'succeeded' | 'failed';
}

/** One adapter per upstream provider. The gateway owns policy and never delegates scope decisions. */
export interface ProviderAdapterPort {
  readonly providerId: string;
  /** Credentials are resolved inside the adapter; callers never pass raw or reference credentials. */
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export interface ReceiptWriterPort {
  append(receipt: UsageReceipt): Promise<UsageReceipt>;
  get(accountId: AccountId, receiptId: string): Promise<UsageReceipt | undefined>;
}

export type UsageExecutionState = 'started' | 'provider_succeeded' | 'holding_consumed' | 'receipt_committed';

export interface UsageExecutionLedgerEntry {
  readonly accountId: AccountId;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly state: UsageExecutionState;
  readonly providerResult?: ProviderExecutionResult;
  readonly holding?: Holding;
  readonly receipt?: UsageReceipt;
}

export interface UsageExecutionLedgerStorePort {
  get(accountId: AccountId, idempotencyKey: string): Promise<UsageExecutionLedgerEntry | undefined>;
  save(entry: UsageExecutionLedgerEntry): Promise<UsageExecutionLedgerEntry>;
}

export interface ClockPort {
  now(): IsoDateTime;
}

export interface SourceUrlPolicyPort {
  canonicalize(raw: string): string;
}

export interface RequestHasherPort {
  hash(value: unknown): string;
}

export interface StagingFenceToken {
  readonly workerId: string;
  readonly epoch: number;
}

/**
 * Atomic persistence boundary for release state. Database adapters must keep
 * fence validation and the mutator commit in one transaction.
 */
export interface StagingTransactionalStorePort<State extends object = Record<string, unknown>> {
  snapshot(): State;
  transact<Result>(
    token: StagingFenceToken,
    mutator: (draft: State) => Result | Promise<Result>,
  ): Promise<Result>;
}

export interface IntentPolicyPort {
  decide(context: {
    readonly now: IsoDateTime;
    readonly key: HourKeyEnvelope;
    readonly grants: readonly AuthorizationGrant[];
    readonly holding?: Holding;
    readonly intent: import('../types/index.js').Intent;
    readonly requestedResource?: Partial<ResourceScope>;
  }): PolicyDecision;
}
