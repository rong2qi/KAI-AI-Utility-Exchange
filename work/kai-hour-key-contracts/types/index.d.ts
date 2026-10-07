export type IsoDateTime = string;
export type AccountId = string;
export type KeyId = string;
export type GrantId = string;
export type HoldingId = string;
export type OfferId = string;
export type ReceiptId = string;
export type ProviderId = string;
export type ModelId = string;
export type RegionId = string;
export type ScopeEpoch = number;

/** User-facing projection of a release result; technical gate fields remain in audit evidence. */
export type ReleaseUserStatus = 'ready' | 'activated' | 'rolled_back' | 'needs_attention';
export type ReleaseUserAction =
  | 'approve_release'
  | 'review_checks'
  | 'fix_checks_and_publish_again'
  | 'rebuild_and_publish'
  | 'review_checks_and_publish_again'
  | 'retry_release';

export interface ReleaseUserResult {
  readonly status: ReleaseUserStatus;
  readonly label: '可发布' | '已激活' | '已自动回滚' | '需要处理';
  readonly message: string;
  readonly version?: string;
  readonly restoredVersion?: string;
  readonly actionRequired: boolean;
  readonly nextAction?: ReleaseUserAction;
}

export type IntentKind = 'compute' | 'discovery' | 'lock' | 'receipt' | 'ambiguous';
export type ComputeCapability = 'compute';
export type DiscoveryCapability = 'discovery.read';
export type LockCapability = 'discovery.lock';
export type ReceiptCapability = 'usage.receipt';
export type Capability =
  | ComputeCapability
  | DiscoveryCapability
  | LockCapability
  | ReceiptCapability;

export type SlotState = 'before_lock' | 'locked_window' | 'active' | 'expired';
export type DecisionCode =
  | 'ALLOW_COMPUTE'
  | 'ALLOW_DISCOVERY'
  | 'ALLOW_LOCK'
  | 'ALLOW_RECEIPT'
  | 'ASK_CLARIFICATION'
  | 'ASK_CONFIRMATION'
  | 'DENY_KEY'
  | 'DENY_EXPIRED'
  | 'DENY_SCOPE'
  | 'SCOPE_EXPANSION_REQUIRED'
  | 'DENY_CAPABILITY'
  | 'DENY_LOCK_DEADLINE'
  | 'DENY_SLOT_NOT_ACTIVE'
  | 'DENY_REVOKED';

export interface ResourceScope {
  readonly models: readonly ModelId[];
  readonly providers: readonly ProviderId[];
  readonly regions: readonly RegionId[];
}

/** A single requested resource; authorization scope contains arrays of allowed values. */
export interface RequestedResource {
  readonly model?: ModelId;
  readonly provider?: ProviderId;
  readonly region?: RegionId;
}

export interface SlotWindow {
  readonly slotStart: IsoDateTime;
  readonly lockDeadline: IsoDateTime;
  readonly slotEnd: IsoDateTime;
  readonly timeZone: string;
}

export interface AuthorizationGrant {
  readonly grantId: GrantId;
  readonly accountId: AccountId;
  readonly version: number;
  /** Monotonic account authorization version; changing scope does not replace key_id. */
  readonly scopeEpoch: ScopeEpoch;
  readonly resourceScope: ResourceScope;
  readonly capabilityScope: readonly Capability[];
  readonly slot: SlotWindow;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  /** Receipt read window; can outlive compute eligibility. */
  readonly receiptUntil: IsoDateTime;
  readonly revokedAt?: IsoDateTime;
  readonly allowProviderSwitch: boolean;
}

/** Public envelope metadata. Upstream secrets and credential material never appear here. */
export interface HourKeyEnvelope {
  readonly keyId: KeyId;
  readonly accountId: AccountId;
  readonly keyVersion: number;
  readonly grantIds: readonly GrantId[];
  readonly audience: 'kai-runtime';
  readonly issuedAt: IsoDateTime;
  /** Account credential expiry; hourly execution expiry belongs to each grant/slot. */
  readonly expiresAt: IsoDateTime;
  /** Allows private Receipt reads after compute expiry. */
  readonly receiptUntil: IsoDateTime;
  readonly manifestUri: string;
  readonly signature: string;
  readonly revocationId: string;
}

export interface Holding {
  readonly holdingId: HoldingId;
  readonly accountId: AccountId;
  readonly grantId: GrantId;
  readonly offerId: OfferId;
  readonly resourceScope: ResourceScope;
  readonly slot: SlotWindow;
  readonly unitsRemaining: number;
  readonly status: 'held' | 'active' | 'exhausted' | 'expired' | 'revoked';
}

export interface Offer {
  readonly offerId: OfferId;
  readonly resource: {
    readonly model: ModelId;
    readonly provider: ProviderId;
    readonly region: RegionId;
  };
  readonly slot: SlotWindow;
  readonly price: { readonly amount: string; readonly currency: string; readonly unit: string };
  readonly availability: 'available' | 'limited' | 'unavailable';
  readonly retrievedAt: IsoDateTime;
  readonly validUntil: IsoDateTime;
  readonly sourceUrl: string;
  readonly executionEligible: boolean;
  readonly hourKeyStatus: 'unpackaged' | 'packaged';
}

export interface UsageReceipt {
  readonly receiptId: ReceiptId;
  readonly accountId: AccountId;
  readonly keyId: KeyId;
  readonly grantId: GrantId;
  readonly holdingId: HoldingId;
  readonly offerId: OfferId;
  readonly idempotencyKey: string;
  /** The Offer was packaged before the usage event was authorized. */
  readonly hourKeyStatus: 'packaged';
  readonly resource: {
    readonly model: ModelId;
    readonly provider: ProviderId;
    readonly region: RegionId;
  };
  readonly slot: SlotWindow;
  readonly requestHash: string;
  readonly usage: { readonly inputUnits: number; readonly outputUnits: number; readonly totalUnits: number };
  readonly status: 'succeeded' | 'failed';
  readonly createdAt: IsoDateTime;
  readonly sourceUrl: string;
}

export interface Intent {
  readonly kind: IntentKind;
  readonly confidence: number;
  readonly requestedResource?: RequestedResource;
  readonly reason: string;
}

export interface PolicyContext {
  readonly now: IsoDateTime;
  readonly key: HourKeyEnvelope;
  readonly grants: readonly AuthorizationGrant[];
  readonly holding?: Holding;
  readonly intent: Intent;
  readonly requestedResource?: RequestedResource;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly code: DecisionCode;
  readonly intent: IntentKind;
  readonly grantId?: GrantId;
  readonly reason: string;
  readonly requiresUserConfirmation: boolean;
  readonly selectedPort?: 'compute' | 'offer_catalog' | 'holding' | 'receipt';
}
