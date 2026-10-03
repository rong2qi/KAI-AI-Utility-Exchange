import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HourKeyRuntime } from '../src/runtime.mjs';
import { HourKeyPackagingAdapter } from '../src/adapters/hour-key-packaging.mjs';
import { JsonHourKeyPackagingStore } from '../src/adapters/json-hour-key-packaging-store.mjs';
import { UsageExecutionLedger } from '../src/usage-ledger.mjs';
import { MemoryClock, MemoryHoldingPort, MemoryHourKeyPackagingPort, MemoryKeyVerifier, MemoryOfferCatalog, MemoryProviderAdapter, MemoryReceiptWriter, MemoryRequestHasher } from './support/fakes.mjs';

const slot = {
  slotStart: '2026-10-02T18:00:00.000Z',
  lockDeadline: '2026-10-02T17:55:00.000Z',
  slotEnd: '2026-10-02T19:00:00.000Z',
  timeZone: 'Asia/Shanghai',
};
const key = {
  keyId: 'kk_test_account_1', accountId: 'acct_1', keyVersion: 1, grantIds: ['grant_a'],
  audience: 'kai-runtime', issuedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', receiptUntil: '2027-01-02T00:00:00.000Z',
  manifestUri: 'https://kai.com/.well-known/kai-agent-manifest.json', signature: 'sig_0123456789abcdef', revocationId: 'rev_1',
};
const grant = {
  grantId: 'grant_a', accountId: 'acct_1', version: 1, scopeEpoch: 1,
  resourceScope: { models: ['model-a'], providers: ['provider-a'], regions: ['region-a'] },
  capabilityScope: ['compute', 'discovery.read', 'discovery.lock', 'usage.receipt'], slot,
  issuedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-10-02T19:00:00.000Z', receiptUntil: '2026-10-03T01:00:00.000Z', allowProviderSwitch: false,
};
const offer = {
  offerId: 'offer_a', resource: { model: 'model-a', provider: 'provider-a', region: 'region-a' }, slot,
  price: { amount: '1.00', currency: 'USD', unit: 'hour' }, availability: 'available',
  retrievedAt: '2026-10-02T17:50:00.000Z', validUntil: '2026-10-02T17:55:00.000Z',
  sourceUrl: 'https://kai.com/offers/offer_a', executionEligible: true, hourKeyStatus: 'packaged',
};
const holding = {
  holdingId: 'holding_a', accountId: 'acct_1', grantId: 'grant_a', offerId: 'offer_a',
  resourceScope: { models: ['model-a'], providers: ['provider-a'], regions: ['region-a'] }, slot,
  unitsRemaining: 2, status: 'held',
};

function makeRuntime(clockValue = '2026-10-02T18:10:00.000Z', offerValue = offer, hourKeyPackagerValue, usageLedgerValue, options = {}) {
  const clock = new MemoryClock(clockValue);
  const catalog = new MemoryOfferCatalog([offerValue]);
  const holdingValue = options.holdingValue ?? holding;
  const holdings = new MemoryHoldingPort({ holdings: [holdingValue], lockTemplates: [holdingValue] });
  const hourKeyPackager = hourKeyPackagerValue ?? new MemoryHourKeyPackagingPort();
  const usageLedger = usageLedgerValue ?? new UsageExecutionLedger();
  const providers = options.providers ?? [['provider-a', new MemoryProviderAdapter('provider-a')]];
  const provider = providers[0][1];
  const receipts = new MemoryReceiptWriter();
  const runtime = new HourKeyRuntime({
    clock,
    keyVerifier: new MemoryKeyVerifier([['kk_test_secret', { key: options.keyValue ?? key, grants: options.grants ?? [grant] }]]),
    offerCatalog: catalog,
    hourKeyPackager,
    holdingPort: holdings,
    providerAdapters: new Map(providers),
    receiptWriter: receipts,
    requestHasher: new MemoryRequestHasher(),
    usageLedger,
  });
  return { runtime, clock, catalog, hourKeyPackager, holdings, provider, receipts };
}

test('ordinary Compute never calls Discovery and emits a Receipt', async () => {
  const { runtime, catalog, provider, receipts } = makeRuntime();
  const result = await runtime.handle({ requestId: 'req_compute', opaqueKey: 'kk_test_secret', userText: '帮我写一段代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_compute' });
  assert.equal(result.kind, 'receipt');
  assert.equal(catalog.queryCalls, 0);
  assert.equal(provider.calls, 1);
  assert.equal(provider.requests[0].idempotencyKey, 'idem_compute');
  assert.equal(receipts.appendCalls, 1);
  assert.equal(result.receipt.hourKeyStatus, 'packaged');
});

test('explicit market intent calls KAI Offer catalog and not Provider', async () => {
  const { runtime, catalog, provider } = makeRuntime();
  const result = await runtime.handle({ requestId: 'req_discovery', opaqueKey: 'kk_test_secret', userText: '查询当前价格和容量' });
  assert.equal(result.kind, 'offers');
  assert.equal(catalog.queryCalls, 1);
  assert.equal(provider.calls, 0);
  assert.equal(result.offers[0].sourceUrl, 'https://kai.com/offers/offer_a');
});

test('Discovery does not depend on Holding storage availability', async () => {
  const setup = makeRuntime();
  setup.holdings.get = async () => { throw new Error('HOLDING_STORE_DOWN'); };
  const result = await setup.runtime.handle({ requestId: 'req_discovery_isolated', opaqueKey: 'kk_test_secret', userText: '查询当前价格和容量' });
  assert.equal(result.kind, 'offers');
  assert.equal(setup.catalog.queryCalls, 1);
});

test('ambiguous recommendation has no side effect until confirmation', async () => {
  const { runtime, catalog, provider } = makeRuntime();
  const result = await runtime.handle({ requestId: 'req_ambiguous', opaqueKey: 'kk_test_secret', userText: '给我推荐一个模型' });
  assert.equal(result.kind, 'policy');
  assert.equal(result.decision.code, 'ASK_CLARIFICATION');
  assert.equal(catalog.queryCalls, 0);
  assert.equal(provider.calls, 0);
});

test('lock requires confirmation and writes through Holding only', async () => {
  const marketOffer = { ...offer, hourKeyStatus: 'unpackaged' };
  const { runtime, holdings, catalog, hourKeyPackager, provider } = makeRuntime('2026-10-02T17:50:00.000Z', marketOffer);
  const preview = await runtime.handle({ requestId: 'req_lock_preview', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_lock_1' });
  assert.equal(preview.kind, 'policy');
  assert.equal(preview.decision.code, 'ASK_CONFIRMATION');
  assert.equal(holdings.lockCalls, 0);
  assert.equal(hourKeyPackager.calls, 0);
  const locked = await runtime.handle({ requestId: 'req_lock', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_lock_1', confirmed: true });
  assert.equal(locked.kind, 'holding');
  assert.equal(holdings.lockCalls, 1);
  assert.equal(catalog.getCalls, 2);
  assert.equal(hourKeyPackager.calls, 1);
  assert.equal(catalog.queryCalls, 0);
  assert.equal(provider.calls, 0);
  const repeated = await runtime.handle({ requestId: 'req_lock_repeat', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_lock_1', confirmed: true });
  assert.equal(repeated.kind, 'holding');
  assert.equal(repeated.holding.holdingId, locked.holding.holdingId);
});

test('lock packaging failure leaves Holding untouched and is retryable', async () => {
  const { runtime, holdings, hourKeyPackager } = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, hourKeyStatus: 'unpackaged' });
  hourKeyPackager.error = new Error('PACKAGING_UPSTREAM_DOWN');
  const result = await runtime.handle({ requestId: 'req_packaging_down', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_packaging_1', confirmed: true });
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'HOUR_KEY_PACKAGING_FAILED');
  assert.equal(result.error.retryable, true);
  assert.equal(hourKeyPackager.calls, 1);
  assert.equal(holdings.lockCalls, 0);
});

test('lock rejects an ineligible Offer before packaging or Holding lock', async () => {
  const setup = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, hourKeyStatus: 'unpackaged', executionEligible: false });
  const result = await setup.runtime.handle({ requestId: 'req_ineligible_offer', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_ineligible_offer', confirmed: true });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'HOUR_KEY_PACKAGING_FAILED');
  assert.equal(result.error.retryable, false);
  assert.equal(setup.hourKeyPackager.calls, 0);
  assert.equal(setup.holdings.lockCalls, 0);
});

test('lock keeps an unavailable Offer retryable without creating a Holding', async () => {
  const setup = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, availability: 'unavailable', hourKeyStatus: 'unpackaged' });
  const result = await setup.runtime.handle({ requestId: 'req_unavailable_offer', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_unavailable_offer', confirmed: true });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'HOUR_KEY_PACKAGING_FAILED');
  assert.equal(result.error.retryable, true);
  assert.equal(setup.hourKeyPackager.calls, 0);
  assert.equal(setup.holdings.lockCalls, 0);
});

test('lock rejects a packager result that downgrades execution eligibility', async () => {
  const unsafePackager = {
    calls: 0,
    async package({ offer }) {
      this.calls += 1;
      return { ...offer, executionEligible: false, hourKeyStatus: 'packaged' };
    },
  };
  const setup = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, hourKeyStatus: 'unpackaged' }, unsafePackager);
  const result = await setup.runtime.handle({ requestId: 'req_packager_downgrade', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_packager_downgrade', confirmed: true });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'HOUR_KEY_PACKAGING_FAILED');
  assert.equal(unsafePackager.calls, 1);
  assert.equal(setup.holdings.lockCalls, 0);
});

test('lock rejects an Offer after its own lock deadline even when the Grant remains open', async () => {
  const offerWithEarlierDeadline = {
    ...offer,
    slot: { ...slot, lockDeadline: '2026-10-02T17:45:00.000Z' },
    validUntil: '2026-10-02T18:00:00.000Z',
    hourKeyStatus: 'unpackaged',
  };
  const setup = makeRuntime('2026-10-02T17:50:00.000Z', offerWithEarlierDeadline);
  const result = await setup.runtime.handle({ requestId: 'req_offer_deadline', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_offer_deadline', confirmed: true });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'LOCK_DEADLINE_CLOSED');
  assert.equal(setup.hourKeyPackager.calls, 0);
  assert.equal(setup.holdings.lockCalls, 0);
});

test('lock rejects a Holding response bound to another Grant or Offer', async () => {
  const setup = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, hourKeyStatus: 'unpackaged' });
  setup.holdings.lock = async () => ({ ...holding, grantId: 'grant_other' });
  const result = await setup.runtime.handle({ requestId: 'req_unbound_holding', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_unbound_holding', confirmed: true });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'HOLDING_LOCK_FAILED');
});

test('persistent packaging survives a Holding lock failure and retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-hour-key-runtime-'));
  try {
    const packager = new HourKeyPackagingAdapter({
      store: new JsonHourKeyPackagingStore({ filePath: join(directory, 'packaging.json') }),
    });
    const setup = makeRuntime('2026-10-02T17:50:00.000Z', { ...offer, hourKeyStatus: 'unpackaged' }, packager);
    const originalLock = setup.holdings.lock.bind(setup.holdings);
    let lockAttempts = 0;
    setup.holdings.lock = async (command) => {
      lockAttempts += 1;
      if (lockAttempts === 1) throw new Error('HOLDING_STORE_TRANSIENT');
      return originalLock(command);
    };
    const command = { opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_persist_retry', confirmed: true };
    const first = await setup.runtime.handle({ requestId: 'req_persist_first', ...command });
    assert.equal(first.kind, 'error');
    assert.equal(first.error.code, 'HOLDING_LOCK_FAILED');
    assert.equal(await packager.store.get('acct_1', command.idempotencyKey).then((stored) => stored.hourKeyStatus), 'packaged');
    const second = await setup.runtime.handle({ requestId: 'req_persist_retry', ...command });
    assert.equal(second.kind, 'holding');
    assert.equal(lockAttempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale market Offer stops before packaging or Holding lock', async () => {
  const { runtime, holdings, hourKeyPackager } = makeRuntime('2026-10-02T17:56:00.000Z', { ...offer, hourKeyStatus: 'unpackaged' });
  const result = await runtime.handle({ requestId: 'req_stale_offer', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_stale_1', confirmed: true });
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'OFFER_STALE');
  assert.equal(result.error.retryable, true);
  assert.equal(hourKeyPackager.calls, 0);
  assert.equal(holdings.lockCalls, 0);
});

test('lock evaluates the actual Offer resource before packaging', async () => {
  const outOfScopeOffer = { ...offer, resource: { ...offer.resource, provider: 'provider-b' }, hourKeyStatus: 'unpackaged' };
  const { runtime, holdings, hourKeyPackager } = makeRuntime('2026-10-02T17:50:00.000Z', outOfScopeOffer);
  const result = await runtime.handle({ requestId: 'req_offer_scope', opaqueKey: 'kk_test_secret', userText: '锁定这个 Offer', offerId: 'offer_a', idempotencyKey: 'idem_scope_1', confirmed: true });
  assert.equal(result.kind, 'policy');
  assert.equal(result.decision.code, 'SCOPE_EXPANSION_REQUIRED');
  assert.equal(hourKeyPackager.calls, 0);
  assert.equal(holdings.lockCalls, 0);
});

test('scope expansion is denied without replacing the account key', async () => {
  const { runtime, catalog, provider } = makeRuntime();
  const result = await runtime.handle({ requestId: 'req_scope', opaqueKey: 'kk_test_secret', userText: '帮我用模型 B 写代码', holdingId: 'holding_a', requestedResource: { model: 'model-b', provider: 'provider-b', region: 'region-a' }, providerInput: 'hello' });
  assert.equal(result.kind, 'policy');
  assert.equal(result.decision.code, 'SCOPE_EXPANSION_REQUIRED');
  assert.equal(catalog.queryCalls, 0);
  assert.equal(provider.calls, 0);
  assert.equal(key.keyId, 'kk_test_account_1');
});

test('Compute rejects a resource outside the existing Holding scope', async () => {
  const widenedGrant = { ...grant, resourceScope: { models: ['model-a', 'model-b'], providers: ['provider-a', 'provider-b'], regions: ['region-a'] } };
  const providerB = new MemoryProviderAdapter('provider-b');
  const setup = makeRuntime('2026-10-02T18:10:00.000Z', offer, undefined, undefined, {
    keyValue: { ...key, grantIds: ['grant_a'] },
    grants: [widenedGrant],
    providers: [['provider-b', providerB]],
  });
  const result = await setup.runtime.handle({ requestId: 'req_holding_scope', opaqueKey: 'kk_test_secret', userText: '帮我写代码', holdingId: 'holding_a', requestedResource: { model: 'model-b', provider: 'provider-b', region: 'region-a' }, providerInput: 'hello', idempotencyKey: 'idem_holding_scope' });

  assert.equal(result.kind, 'policy');
  assert.equal(result.decision.code, 'DENY_SCOPE');
  assert.equal(providerB.calls, 0);
  assert.equal(setup.holdings.consumeCalls, 0);
});

test('Compute binds the selected Grant to the Holding grant', async () => {
  const grantB = { ...grant, grantId: 'grant_b', scopeEpoch: 2 };
  const setup = makeRuntime('2026-10-02T18:10:00.000Z', offer, undefined, undefined, {
    keyValue: { ...key, grantIds: ['grant_b', 'grant_a'] },
    grants: [grantB, grant],
  });
  const result = await setup.runtime.handle({ requestId: 'req_grant_binding', opaqueKey: 'kk_test_secret', userText: '帮我写代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_grant_binding' });

  assert.equal(result.kind, 'receipt');
  assert.equal(result.decision.grantId, 'grant_a');
  assert.equal(result.receipt.grantId, 'grant_a');
});

test('Compute rejects an expired Holding even when the Grant remains active', async () => {
  const expiredHolding = { ...holding, slot: { ...slot, slotEnd: '2026-10-02T18:05:00.000Z' } };
  const setup = makeRuntime('2026-10-02T18:10:00.000Z', offer, undefined, undefined, { holdingValue: expiredHolding });
  const result = await setup.runtime.handle({ requestId: 'req_holding_expired', opaqueKey: 'kk_test_secret', userText: '帮我写代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_holding_expired' });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'SLOT_NOT_ACTIVE');
  assert.equal(setup.provider.calls, 0);
  assert.equal(setup.holdings.consumeCalls, 0);
});

test('Compute rejects an idempotency key shorter than the transport contract', async () => {
  const setup = makeRuntime();
  const result = await setup.runtime.handle({ requestId: 'req_short_idempotency', opaqueKey: 'kk_test_secret', userText: '帮我写代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'short' });

  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'REQUEST_INVALID');
  assert.equal(setup.provider.calls, 0);
});

test('Receipt remains readable after the compute window closes', async () => {
  const { runtime, receipts } = makeRuntime();
  const computed = await runtime.handle({ requestId: 'req_after', opaqueKey: 'kk_test_secret', userText: '帮我写一段代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_after' });
  assert.equal(computed.kind, 'receipt');
  const later = makeRuntime('2026-10-02T20:00:00.000Z');
  later.receipts.receipts = receipts.receipts;
  const read = await later.runtime.handle({ requestId: 'req_receipt', opaqueKey: 'kk_test_secret', userText: '查看使用凭证', receiptId: 'rcpt_acct_1_idem_after' });
  assert.equal(read.kind, 'receipt');
});

test('provider failure does not consume Holding or write Receipt', async () => {
  const setup = makeRuntime();
  setup.provider.execute = async () => { throw new Error('UPSTREAM_DOWN'); };
  const result = await setup.runtime.handle({ requestId: 'req_provider_down', opaqueKey: 'kk_test_secret', userText: '帮我写一段代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_provider_down' });
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(setup.holdings.consumeCalls, 0);
  assert.equal(setup.receipts.appendCalls, 0);
});

test('runtime resumes a failed Receipt write without repeating Provider or Holding side effects', async () => {
  const setup = makeRuntime();
  const originalAppend = setup.receipts.append.bind(setup.receipts);
  let failReceipt = true;
  setup.receipts.append = async (receipt) => {
    if (failReceipt) throw new Error('RECEIPT_STORE_TRANSIENT');
    return originalAppend(receipt);
  };
  const command = { opaqueKey: 'kk_test_secret', userText: '帮我写一段代码', holdingId: 'holding_a', providerInput: 'hello', idempotencyKey: 'idem_receipt_resume' };
  const first = await setup.runtime.handle({ requestId: 'req_receipt_first', ...command });
  assert.equal(first.kind, 'error');
  assert.equal(first.error.code, 'RECEIPT_WRITE_FAILED');
  assert.equal(first.error.retryable, true);
  assert.equal(setup.provider.calls, 1);
  assert.equal(setup.holdings.consumeCalls, 1);

  failReceipt = false;
  const second = await setup.runtime.handle({ requestId: 'req_receipt_retry', ...command });
  assert.equal(second.kind, 'receipt');
  assert.equal(setup.provider.calls, 1);
  assert.equal(setup.holdings.consumeCalls, 1);
  assert.equal(setup.receipts.appendCalls, 1);
});

test('Compute requires an explicit idempotency key', async () => {
  const setup = makeRuntime();
  const result = await setup.runtime.handle({ requestId: 'req_missing_idempotency', opaqueKey: 'kk_test_secret', userText: '帮我写一段代码', holdingId: 'holding_a', providerInput: 'hello' });
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'REQUEST_INVALID');
  assert.equal(setup.provider.calls, 0);
  assert.equal(setup.holdings.consumeCalls, 0);
});

test('untrusted Offer source fails before returning Discovery data', async () => {
  const setup = makeRuntime();
  setup.catalog.offers[0] = { ...offer, sourceUrl: 'https://evil.example/offer_a' };
  const result = await setup.runtime.handle({ requestId: 'req_bad_source', opaqueKey: 'kk_test_secret', userText: '查询当前价格' });
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'SOURCE_URL_UNTRUSTED');
});
