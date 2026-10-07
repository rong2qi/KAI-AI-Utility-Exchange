import type { AccountId, HourKeyEnvelope, Offer, UsageReceipt } from '../types/index.js';
import type { HourKeyRuntimePort, RuntimeRequest } from '../ports/runtime.js';
import type { HourKeyPackagingPort, HoldingPort, ProviderAdapterPort, StagingTargetPort, StagingTransactionalStorePort } from '../ports/index.js';

const accountId: AccountId = 'acct-typecheck';

const envelope: HourKeyEnvelope = {
  keyId: 'key-typecheck',
  accountId,
  keyVersion: 1,
  grantIds: ['grant-typecheck'],
  audience: 'kai-runtime',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T01:00:00.000Z',
  receiptUntil: '2026-01-01T02:00:00.000Z',
  manifestUri: 'https://example.test/manifest',
  signature: 'signature-typecheck',
  revocationId: 'revoke-typecheck',
};

const offer: Offer = {
  offerId: 'offer-typecheck',
  resource: { model: 'model-typecheck', provider: 'provider-typecheck', region: 'region-typecheck' },
  slot: {
    slotStart: '2026-01-01T00:00:00.000Z',
    lockDeadline: '2026-01-01T00:05:00.000Z',
    slotEnd: '2026-01-01T01:00:00.000Z',
    timeZone: 'UTC',
  },
  price: { amount: '1.00', currency: 'USD', unit: 'hour' },
  availability: 'available',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: '2026-01-01T00:05:00.000Z',
  sourceUrl: 'https://example.test/offer',
  executionEligible: true,
  hourKeyStatus: 'packaged',
};

const receipt: UsageReceipt = {
  receiptId: 'receipt-typecheck',
  accountId,
  keyId: envelope.keyId,
  grantId: 'grant-typecheck',
  holdingId: 'holding-typecheck',
  offerId: offer.offerId,
  idempotencyKey: 'idempotency-typecheck',
  hourKeyStatus: 'packaged',
  resource: offer.resource,
  slot: offer.slot,
  requestHash: 'hash-typecheck',
  usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 },
  status: 'succeeded',
  createdAt: '2026-01-01T00:10:00.000Z',
  sourceUrl: offer.sourceUrl,
};

const request: RuntimeRequest = {
  requestId: 'request-typecheck',
  opaqueKey: 'opaque-typecheck',
  userText: 'run compute',
  idempotencyKey: 'idempotency-typecheck',
  holdingId: 'holding-typecheck',
  providerInput: { prompt: 'typecheck' },
};
const idempotencyKey = request.idempotencyKey ?? 'idempotency-typecheck';

declare const runtime: HourKeyRuntimePort;
declare const packaging: HourKeyPackagingPort;
declare const holding: HoldingPort;
declare const provider: ProviderAdapterPort;
declare const stagingStore: StagingTransactionalStorePort<{ activeVersion: string | null }>;
declare const stagingTarget: StagingTargetPort;

void runtime.handle(request);
void packaging.package({ accountId, offer, idempotencyKey });
void holding.get(accountId, 'holding-typecheck');
void provider.execute({
  model: offer.resource.model,
  region: offer.resource.region,
  input: request.providerInput,
  requestId: request.requestId,
  idempotencyKey,
});
void stagingStore.snapshot().activeVersion;
void stagingStore.transact({ workerId: 'worker-typecheck', epoch: 1 }, (draft) => {
  draft.activeVersion = 'v-typecheck';
  return draft.activeVersion;
});
void stagingTarget.inspect();
void stagingTarget.activate({ version: 'v-typecheck', digest: 'digest-typecheck' });
void stagingTarget.healthCheck({ version: 'v-typecheck', digest: 'digest-typecheck' });
void stagingTarget.rollback({ version: 'v-typecheck', digest: 'digest-typecheck', reason: 'typecheck' });

const receiptStatus: UsageReceipt['hourKeyStatus'] = receipt.hourKeyStatus;
void receiptStatus;

// One selected resource differs from arrays of authorized scope values.
const selectedRequest: RuntimeRequest = { ...request, requestedResource: { model: 'model-typecheck' } };
void selectedRequest;
// @ts-expect-error ResourceScope arrays are not a single requested resource.
const wrongResource: RuntimeRequest = { ...request, requestedResource: { models: ['model-typecheck'] } };
void wrongResource;

declare const exchangeFactory: (options: import('../ports/exchange.js').ExchangeServerOptions) => import('../ports/exchange.js').ExchangeServerPort;
void exchangeFactory({ runtime, host: '127.0.0.1', maxConcurrentRequests: 8 }).listen();
// @ts-expect-error The local sandbox gateway cannot be bound publicly.
void exchangeFactory({ runtime, host: '0.0.0.0' });
