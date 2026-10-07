import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExchangeSandbox } from '../src/exchange-sandbox.mjs';

const opaqueKey = 'exchange-local-test-credential';
const now = () => '2026-10-07T06:12:00.000Z';
const compute = (setup, overrides = {}) => ({
  requestId: 'request-exchange-sandbox', opaqueKey, userText: '生成简短说明',
  holdingId: setup.fixture.holdingId,
  requestedResource: {
    model: setup.fixture.model, provider: setup.fixture.provider, region: setup.fixture.region,
  },
  providerInput: { messages: [{ role: 'user', content: 'hello' }] },
  idempotencyKey: 'exchange-request-one',
  ...overrides,
});

test('preauthorized sandbox executes through the Runtime and records one debit and receipt', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now });
  const authorization = await setup.runtime.keyVerifier.verify(opaqueKey);
  assert.equal(authorization.key.audience, 'kai-runtime');
  assert.equal(authorization.key.manifestUri, 'urn:kai:sandbox:exchange-manifest');
  assert.equal(authorization.key.signature, 'sandbox-unsigned-envelope-v1');
  assert.equal(authorization.key.revocationId, 'revocation_exchange_sandbox');
  assert.ok(Date.parse(authorization.key.expiresAt) > Date.parse(authorization.grants[0].expiresAt));
  assert.equal(authorization.grants[0].expiresAt, setup.fixture.slot.slotEnd);
  const result = await setup.runtime.handle(compute(setup));
  assert.equal(result.kind, 'receipt');
  assert.equal(result.receipt.accountId, setup.fixture.accountId);
  assert.equal(result.receipt.holdingId, setup.fixture.holdingId);
  assert.deepEqual(setup.inspect(), { providerCalls: 1, providerExecutions: 1, unitsRemaining: 9, receiptCount: 1 });
  assert.equal(JSON.stringify({ fixture: setup.fixture, inspection: setup.inspect(), result }).includes(opaqueKey), false);
});

test('a consumed final unit can replay the same operation without a second debit', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now, units: 1 });
  const first = await setup.runtime.handle(compute(setup));
  const repeated = await setup.runtime.handle(compute(setup, { requestId: 'request-retry' }));
  assert.equal(first.kind, 'receipt');
  assert.equal(repeated.kind, 'receipt');
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.deepEqual(setup.inspect(), { providerCalls: 1, providerExecutions: 1, unitsRemaining: 0, receiptCount: 1 });
});

test('Receipt append accepts only the same prepared candidate and preserves the original on every conflict', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now });
  const result = await setup.runtime.handle(compute(setup));
  assert.equal(result.kind, 'receipt');
  const receipt = result.receipt;
  const writer = setup.runtime.receiptWriter;
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  reordered.usage = Object.fromEntries(Object.entries(receipt.usage).reverse());
  assert.deepEqual(await writer.append(reordered), receipt);
  const altered = [
    { requestHash: 'changed-hash' },
    { receiptId: 'changed-receipt' },
    { keyId: 'changed-key' },
    { grantId: 'changed-grant' },
    { offerId: 'changed-offer' },
    { resource: { ...receipt.resource, model: 'changed-model' } },
    { slot: { ...receipt.slot, slotEnd: '2099-01-01T00:00:00.000Z' } },
    { usage: { inputUnits: 10, outputUnits: 20, totalUnits: 30 } },
    { status: 'failed' },
    { createdAt: '2026-10-07T06:13:00.000Z' },
    { sourceUrl: 'https://kai.com/offers/changed-offer' },
    { hourKeyStatus: 'unpackaged' },
    { output: 'must not be attached to a Receipt' },
  ];
  for (const change of altered) {
    await assert.rejects(writer.append({ ...receipt, ...change }), /IDEMPOTENCY_CONFLICT/, Object.keys(change)[0]);
    assert.deepEqual(await writer.get(receipt.accountId, receipt.receiptId), receipt);
  }
  assert.deepEqual(setup.inspect(), { providerCalls: 1, providerExecutions: 1, unitsRemaining: 9, receiptCount: 1 });
});

test('two competing operations cannot invoke the Provider twice for a final unit', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now, units: 1 });
  const results = await Promise.all([
    setup.runtime.handle(compute(setup)),
    setup.runtime.handle(compute(setup, { idempotencyKey: 'competing-operation' })),
  ]);
  assert.equal(results.filter((result) => result.kind === 'receipt').length, 1);
  assert.equal(results.find((result) => result.kind === 'error').error.code, 'HOLDING_EXHAUSTED');
  assert.deepEqual(setup.inspect(), { providerCalls: 1, providerExecutions: 1, unitsRemaining: 0, receiptCount: 1 });
});

test('JSON object key order does not change operation identity but changed content conflicts', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now });
  const first = await setup.runtime.handle(compute(setup, { providerInput: { a: 1, nested: { x: true, y: null } } }));
  const same = await setup.runtime.handle(compute(setup, { providerInput: { nested: { y: null, x: true }, a: 1 } }));
  const changed = await setup.runtime.handle(compute(setup, { providerInput: { a: 2, nested: { x: true, y: null } } }));
  assert.deepEqual(same.receipt, first.receipt);
  assert.equal(changed.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(setup.inspect().providerCalls, 1);
});

test('wrong credentials and out-of-scope resources leave all execution counters untouched', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now });
  const invalidKey = await setup.runtime.handle(compute(setup, { opaqueKey: 'wrong-credential' }));
  assert.equal(invalidKey.error.code, 'KEY_INVALID');
  const foreignHolding = await setup.runtime.handle(compute(setup, { holdingId: 'other-account-holding' }));
  assert.equal(foreignHolding.error.code, 'HOLDING_REQUIRED');
  const foreignResource = await setup.runtime.handle(compute(setup, { requestedResource: { provider: 'real-provider' } }));
  assert.equal(foreignResource.kind, 'policy');
  assert.equal(foreignResource.decision.allowed, false);
  assert.deepEqual(setup.inspect(), { providerCalls: 0, providerExecutions: 0, unitsRemaining: 10, receiptCount: 0 });
});

test('receipt stays readable after the hour closes while new compute is denied', async () => {
  let current = '2026-10-07T06:12:00.000Z';
  const setup = createExchangeSandbox({ opaqueKey, now: () => current });
  const result = await setup.runtime.handle(compute(setup));
  current = '2026-10-07T07:00:00.000Z';
  const expired = await setup.runtime.handle(compute(setup, { idempotencyKey: 'new-request-expired' }));
  assert.equal(expired.kind, 'policy');
  assert.equal(expired.decision.code, 'DENY_EXPIRED');
  const receipt = await setup.runtime.handle({ requestId: 'read-receipt', opaqueKey, userText: '查看使用凭证', receiptId: result.receipt.receiptId });
  assert.deepEqual(receipt.receipt, result.receipt);
  assert.equal(setup.inspect().providerCalls, 1);
});

test('sandbox fixture is a snapshot and does not expose writable authorization state', async () => {
  const setup = createExchangeSandbox({ opaqueKey, now });
  assert.deepEqual(setup.fixture.slot, {
    slotStart: '2026-10-07T06:00:00.000Z', lockDeadline: '2026-10-07T05:55:00.000Z',
    slotEnd: '2026-10-07T07:00:00.000Z', timeZone: 'Asia/Shanghai',
  });
  setup.fixture.slot.slotEnd = '2099-01-01T00:00:00.000Z';
  setup.fixture.units = 1_000;
  const result = await setup.runtime.handle(compute(setup));
  assert.equal(result.receipt.slot.slotEnd, '2026-10-07T07:00:00.000Z');
  result.receipt.slot.slotEnd = '2099-01-01T00:00:00.000Z';
  const replay = await setup.runtime.handle(compute(setup));
  assert.equal(replay.receipt.slot.slotEnd, '2026-10-07T07:00:00.000Z');
  assert.equal(setup.inspect().unitsRemaining, 9);
});

test('construction rejects missing credentials, malformed clocks, and invalid prepaid unit counts', () => {
  for (const invalid of [undefined, '', 42, 'x'.repeat(4097)]) {
    assert.throws(() => createExchangeSandbox({ opaqueKey: invalid, now }), /SANDBOX_KEY_REQUIRED/);
  }
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createExchangeSandbox({ opaqueKey, now, units: invalid }), /SANDBOX_UNITS_INVALID/);
  }
  assert.throws(() => createExchangeSandbox({ opaqueKey, now: 'invalid' }), /SANDBOX_CLOCK_INVALID/);
  assert.throws(() => createExchangeSandbox({ opaqueKey, now: () => 'invalid' }), /SANDBOX_CLOCK_INVALID/);
});
