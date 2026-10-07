import type {
  AccountId,
  AuthorizationGrant,
  Holding,
  HourKeyEnvelope,
  IsoDateTime,
  Offer,
  OfferId,
  PolicyDecision,
  RequestedResource,
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
  readonly requestedResource?: RequestedResource;
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
  /** Runtime supplies a stable hash scoped to the account and client idempotency key. */
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
  /** Atomically insert or return the first Receipt for (accountId, idempotencyKey).
   * Replays have no additional write effect; conflicting requestHash/binding/usage
   * must fail with IDEMPOTENCY_CONFLICT, never overwrite. receiptId is account-unique.
   * Reservation recovery passes an already prepared candidate and requires that
   * exact candidate back. Production adapters must prove these semantics separately.
   */
  append(receipt: UsageReceipt): Promise<UsageReceipt>;
  /** Private lookup must remain account-scoped. */
  get(accountId: AccountId, receiptId: string): Promise<UsageReceipt | undefined>;
}

export type UsageExecutionState = 'started' | 'provider_succeeded' | 'holding_consumed' | 'receipt_committed';

/** These facts cannot change while resuming one account-bound execution. */
export interface UsageExecutionBinding {
  readonly keyId: string;
  readonly grantId: string;
  readonly holdingId: string;
  readonly offerId: string;
  readonly model: string;
  readonly provider: string;
  readonly region: string;
}

export interface UsageExecutionLedgerEntry {
  readonly accountId: AccountId;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly binding: UsageExecutionBinding;
  readonly state: UsageExecutionState;
  readonly providerResult?: ProviderExecutionResult;
  readonly holding?: Holding;
  readonly receipt?: UsageReceipt;
}

/** Private Compute response; output must not be copied into public evidence or Receipts. */
export interface UsageExecutionResult {
  readonly receipt: UsageReceipt;
  readonly output: unknown;
}

export interface UsageExecutionCommand extends UsageExecutionBinding {
  readonly accountId: AccountId;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly providerInput: unknown;
  readonly requestId: string;
  readonly at: IsoDateTime;
  readonly providerAdapter: ProviderAdapterPort;
  readonly holdingPort: HoldingPort;
  readonly receiptWriter: ReceiptWriterPort;
  /** Runs only before a new Provider execution, not on a settled result replay. */
  readonly beforeProviderExecution?: () => void | Promise<void>;
  readonly buildReceipt: (facts: { providerResult: ProviderExecutionResult; holding: Holding }) => UsageReceipt;
}

export interface UsageExecutionLedgerPort {
  /** Only injected atomic reservation implementations may bypass per-Holding Runtime serialization. */
  readonly admissionMode?: 'atomic-reservation';
  execute(command: UsageExecutionCommand): Promise<UsageReceipt>;
  executeWithResult(command: UsageExecutionCommand): Promise<UsageExecutionResult>;
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

export interface StagingTargetArtifact {
  readonly version: string;
  readonly digest: string;
}

export interface StagingTargetInspection {
  readonly targetId: string;
  readonly networkDisabled: boolean;
  readonly realStagingProof: boolean;
  readonly active: StagingTargetArtifact | null;
}

export interface StagingTargetHealthCheck extends StagingTargetArtifact {
  readonly status: 'passed' | 'failed';
  readonly reason?: string;
}

/** Replaceable deployment destination boundary; platform credentials stay inside its adapter. */
export interface StagingTargetPort {
  readonly targetId: string;
  inspect(): Promise<StagingTargetInspection>;
  activate(artifact: StagingTargetArtifact): Promise<StagingTargetArtifact & { readonly status: 'activated' }>;
  healthCheck(artifact: StagingTargetArtifact): Promise<StagingTargetHealthCheck>;
  rollback(request: StagingTargetArtifact & { readonly reason: string }): Promise<StagingTargetArtifact & { readonly status: 'rolled_back'; readonly reason: string }>;
}

export interface IntentPolicyPort {
  decide(context: {
    readonly now: IsoDateTime;
    readonly key: HourKeyEnvelope;
    readonly grants: readonly AuthorizationGrant[];
    readonly holding?: Holding;
    readonly intent: import('../types/index.js').Intent;
    readonly requestedResource?: RequestedResource;
  }): PolicyDecision;
}
