import { createHash, timingSafeEqual } from 'node:crypto';
import { HourKeyRuntime } from './runtime.mjs';
import { HourKeyPackagingAdapter } from './adapters/hour-key-packaging.mjs';
import { SandboxProviderAdapter } from './adapters/sandbox-provider.mjs';
import { UsageExecutionLedger } from './usage-ledger.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest();
const scopedKey = (accountId, id) => JSON.stringify([accountId, id]);

// JSON objects have no semantic key order. Arrays retain their order.
function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('REQUEST_JSON_INVALID');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('REQUEST_JSON_INVALID');
  }
  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? `[${Array.from(value, (item) => canonicalJson(item, ancestors)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

/**
 * In-process composition for the Exchange entry point. This creates one explicit
 * preauthorized test Holding; it does not book, charge, or contact a Provider.
 * All records are ephemeral and must not be used as a production store.
 */
export function createExchangeSandbox({ opaqueKey, now = () => new Date().toISOString(), units = 10 } = {}) {
  if (typeof opaqueKey !== 'string' || opaqueKey.length === 0 || opaqueKey.length > 4096) throw new Error('SANDBOX_KEY_REQUIRED');
  if (typeof now !== 'function') throw new Error('SANDBOX_CLOCK_INVALID');
  if (!Number.isSafeInteger(units) || units < 1) throw new Error('SANDBOX_UNITS_INVALID');
  const current = Date.parse(now());
  if (!Number.isFinite(current)) throw new Error('SANDBOX_CLOCK_INVALID');
  const hourStart = Math.floor(current / HOUR_MS) * HOUR_MS;
  const iso = (offset) => new Date(hourStart + offset).toISOString();
  const slot = {
    slotStart: iso(0), lockDeadline: iso(-300_000), slotEnd: iso(HOUR_MS), timeZone: 'Asia/Shanghai',
  };
  const accountId = 'acct_exchange_sandbox';
  const holdingId = 'holding_exchange_sandbox';
  const grantId = 'grant_exchange_sandbox';
  const offerId = 'offer_exchange_sandbox';
  const model = 'model-a';
  const provider = 'exchange-sandbox-v1';
  const region = 'sandbox-local';
  const resourceScope = { models: [model], providers: [provider], regions: [region] };
  const expectedDigest = digest(opaqueKey);
  const key = {
    keyId: 'key_exchange_sandbox', accountId, grantIds: [grantId], keyVersion: 1,
    audience: 'kai-runtime', issuedAt: iso(0), expiresAt: iso(30 * DAY_MS), receiptUntil: iso(31 * DAY_MS),
    manifestUri: 'urn:kai:sandbox:exchange-manifest',
    // Explicit fixture metadata; this sandbox verifies the opaque credential hash, not a signature.
    signature: 'sandbox-unsigned-envelope-v1', revocationId: 'revocation_exchange_sandbox',
  };
  const grant = {
    grantId, accountId, version: 1, scopeEpoch: 1, resourceScope,
    capabilityScope: ['compute', 'usage.receipt'], slot,
    issuedAt: iso(0), expiresAt: slot.slotEnd, receiptUntil: iso(HOUR_MS + DAY_MS),
    allowProviderSwitch: false,
  };
  let holding = { holdingId, accountId, grantId, offerId, resourceScope, slot, unitsRemaining: units, status: 'held' };
  const consumptions = new Map();
  const receipts = new Map();
  const receiptIds = new Map();
  const providerAdapter = new SandboxProviderAdapter({ providerId: provider, supportedModels: [model], supportedRegions: [region] });
  const runtime = new HourKeyRuntime({
    clock: { now },
    keyVerifier: {
      async verify(candidate) {
        if (typeof candidate !== 'string' || candidate.length > 4096 || !timingSafeEqual(digest(candidate), expectedDigest)) {
          throw new Error('KEY_INVALID');
        }
        return clone({ key, grants: [grant] });
      },
    },
    offerCatalog: { async query() { return []; }, async get() { return undefined; } },
    hourKeyPackager: new HourKeyPackagingAdapter(),
    holdingPort: {
      async get(requestAccount, requestHolding) {
        return requestAccount === accountId && requestHolding === holdingId ? clone(holding) : undefined;
      },
      async lock() { throw new Error('SANDBOX_HOLDING_PREAUTHORIZED'); },
      async consume(command) {
        if (command.accountId !== accountId || command.holdingId !== holdingId) throw new Error('HOLDING_REQUIRED');
        if (!Number.isSafeInteger(command.units) || command.units < 1 || !command.idempotencyKey) throw new Error('EXECUTION_COMMAND_INVALID');
        const identity = scopedKey(command.accountId, command.idempotencyKey);
        const existing = consumptions.get(identity);
        if (existing) {
          if (existing.units !== command.units) throw new Error('IDEMPOTENCY_CONFLICT');
          return clone(existing.holding);
        }
        if (holding.unitsRemaining < command.units) throw new Error('HOLDING_EXHAUSTED');
        holding = { ...holding, unitsRemaining: holding.unitsRemaining - command.units };
        holding.status = holding.unitsRemaining === 0 ? 'exhausted' : 'active';
        consumptions.set(identity, { units: command.units, holding: clone(holding) });
        return clone(holding);
      },
    },
    providerAdapters: new Map([[provider, providerAdapter]]),
    receiptWriter: {
      async append(receipt) {
        if (receipt.accountId !== accountId || receipt.holdingId !== holdingId) throw new Error('RECEIPT_SCOPE_INVALID');
        const identity = scopedKey(receipt.accountId, receipt.idempotencyKey);
        const existing = receipts.get(identity);
        if (existing) {
          if (existing.requestHash !== receipt.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
          return clone(existing);
        }
        const lookup = scopedKey(receipt.accountId, receipt.receiptId);
        if (receiptIds.has(lookup)) throw new Error('IDEMPOTENCY_CONFLICT');
        receipts.set(identity, clone(receipt));
        receiptIds.set(lookup, identity);
        return clone(receipt);
      },
      async get(requestAccount, receiptId) {
        return clone(receipts.get(receiptIds.get(scopedKey(requestAccount, receiptId))));
      },
    },
    requestHasher: { hash: (facts) => digest(canonicalJson(facts)).toString('hex') },
    usageLedger: new UsageExecutionLedger(),
  });
  return {
    runtime,
    fixture: { accountId, holdingId, model, provider, region, slot: clone(slot), units },
    inspect: () => ({
      providerCalls: providerAdapter.calls, providerExecutions: providerAdapter.executions,
      unitsRemaining: holding.unitsRemaining, receiptCount: receipts.size,
    }),
  };
}
