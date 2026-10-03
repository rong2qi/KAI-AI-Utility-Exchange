import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { canExecuteAlternative, classifyIntent, evaluateIntent, slotState, validateSlotWindow } from '../src/policy.mjs';
import { canonicalizeKaiSourceUrl } from '../src/source-policy.mjs';

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

test('ordinary compute intent does not open discovery', () => {
  assert.equal(classifyIntent('帮我写一段代码').kind, 'compute');
  const decision = evaluateIntent({ now: '2026-10-02T18:10:00.000Z', key, grants: [grant], intent: classifyIntent('帮我写一段代码') });
  assert.deepEqual({ allowed: decision.allowed, code: decision.code, selectedPort: decision.selectedPort }, { allowed: true, code: 'ALLOW_COMPUTE', selectedPort: 'compute' });
});

test('explicit dynamic question opens only the Offer catalog', () => {
  const intent = classifyIntent('查询当前价格和容量');
  const decision = evaluateIntent({ now: '2026-10-02T18:10:00.000Z', key, grants: [grant], intent });
  assert.equal(intent.kind, 'discovery');
  assert.equal(decision.code, 'ALLOW_DISCOVERY');
  assert.equal(decision.selectedPort, 'offer_catalog');
});

test('ambiguous recommendation asks before querying', () => {
  const intent = classifyIntent('给我推荐一个模型');
  const decision = evaluateIntent({ now: '2026-10-02T18:10:00.000Z', key, grants: [grant], intent });
  assert.equal(intent.kind, 'ambiguous');
  assert.equal(decision.code, 'ASK_CLARIFICATION');
});

test('cross-provider execution is denied while the same account key remains usable', () => {
  const decision = evaluateIntent({
    now: '2026-10-02T18:10:00.000Z', key, grants: [grant],
    intent: { kind: 'compute', confidence: 1, reason: 'explicit' },
    requestedResource: { model: 'model-a', provider: 'provider-b', region: 'region-a' },
  });
  assert.equal(decision.code, 'SCOPE_EXPANSION_REQUIRED');
});

test('a new grant changes model scope without changing the account key', () => {
  const nextSlot = { ...slot, slotStart: '2026-10-02T19:00:00.000Z', lockDeadline: '2026-10-02T18:55:00.000Z', slotEnd: '2026-10-02T20:00:00.000Z' };
  const grantB = { ...grant, grantId: 'grant_b', scopeEpoch: 2, slot: nextSlot, issuedAt: '2026-10-02T19:00:00.000Z', expiresAt: '2026-10-02T20:00:00.000Z', resourceScope: { models: ['model-b'], providers: ['provider-b'], regions: ['region-a'] } };
  const keyB = { ...key, grantIds: ['grant_a', 'grant_b'] };
  const decision = evaluateIntent({ now: '2026-10-02T19:10:00.000Z', key: keyB, grants: [grant, grantB], intent: { kind: 'compute', confidence: 1, reason: 'explicit' }, requestedResource: { model: 'model-b', provider: 'provider-b', region: 'region-a' } });
  assert.equal(keyB.keyId, key.keyId);
  assert.equal(decision.code, 'ALLOW_COMPUTE');
  assert.equal(decision.grantId, 'grant_b');
});

test('hour boundaries are explicit and deterministic', () => {
  assert.equal(validateSlotWindow(slot), true);
  assert.equal(slotState(slot, '2026-10-02T17:54:59.999Z'), 'before_lock');
  assert.equal(slotState(slot, '2026-10-02T17:55:00.000Z'), 'locked_window');
  assert.equal(slotState(slot, '2026-10-02T18:00:00.000Z'), 'active');
  assert.equal(slotState(slot, '2026-10-02T19:00:00.000Z'), 'expired');
});

test('alternative selection needs switch permission and matching resource scope', () => {
  const requestedResource = { model: 'model-a', provider: 'provider-b', region: 'region-a' };
  const expanded = { ...grant, resourceScope: { ...grant.resourceScope, providers: ['provider-a', 'provider-b'] } };
  assert.equal(canExecuteAlternative({ grant: expanded, requestedResource }), false);
  assert.equal(canExecuteAlternative({ grant: { ...expanded, allowProviderSwitch: undefined }, requestedResource }), false);
  assert.equal(canExecuteAlternative({ grant: { ...expanded, allowProviderSwitch: true }, requestedResource }), true);
  assert.equal(canExecuteAlternative({ grant: { ...grant, allowProviderSwitch: true }, requestedResource }), false);
});

test('invalid slot ordering is rejected before authorization', () => {
  assert.throws(() => validateSlotWindow({ ...slot, lockDeadline: '2026-10-02T18:01:00.000Z' }), /SLOT_WINDOW_INVALID/);
  assert.throws(() => slotState({ ...slot, slotEnd: '2026-10-02T17:00:00.000Z' }, '2026-10-02T18:00:00.000Z'), /SLOT_WINDOW_INVALID/);
});

test('compute is rejected outside the active slot and receipts remain readable after expiry', () => {
  const compute = evaluateIntent({ now: '2026-10-02T17:58:00.000Z', key, grants: [grant], intent: { kind: 'compute', confidence: 1, reason: 'explicit' } });
  assert.equal(compute.code, 'DENY_SLOT_NOT_ACTIVE');
  const receipt = evaluateIntent({ now: '2026-10-02T20:01:00.000Z', key, grants: [grant], intent: { kind: 'receipt', confidence: 1, reason: 'explicit' } });
  assert.equal(receipt.code, 'ALLOW_RECEIPT');
});

test('provider/model recommendation asks before opening Discovery', () => {
  const intent = classifyIntent('给我推荐一个模型');
  const decision = evaluateIntent({ now: '2026-10-02T18:10:00.000Z', key, grants: [grant], intent });
  assert.equal(intent.kind, 'ambiguous');
  assert.equal(decision.code, 'ASK_CLARIFICATION');
  assert.equal(decision.selectedPort, undefined);
});

test('wire schemas are strict and keep secrets out of the envelope', async () => {
  const envelope = JSON.parse(await readFile(new URL('../schema/hour-key-envelope.schema.json', import.meta.url)));
  const grantSchema = JSON.parse(await readFile(new URL('../schema/authorization-grant.schema.json', import.meta.url)));
  const offerSchema = JSON.parse(await readFile(new URL('../schema/offer.schema.json', import.meta.url)));
  assert.equal(envelope.additionalProperties, false);
  assert.equal(grantSchema.additionalProperties, false);
  assert.ok(!envelope.properties.provider_api_key);
  assert.ok(!envelope.properties.secret);
  assert.equal(grantSchema.properties.allow_provider_switch.type, 'boolean');
  assert.equal(grantSchema.properties.allow_provider_switch.default, false);
  assert.deepEqual(offerSchema.properties.hour_key_status.enum, ['unpackaged', 'packaged']);
});

test('source URLs are canonicalized to approved KAI fact pages', () => {
  assert.equal(canonicalizeKaiSourceUrl('https://kai.com/offers/offer_a'), 'https://kai.com/offers/offer_a');
  assert.throws(() => canonicalizeKaiSourceUrl('https://evil.example/offers/offer_a'), /SOURCE_URL_UNTRUSTED_ORIGIN/);
  assert.throws(() => canonicalizeKaiSourceUrl('https://kai.com/offers/offer_a?redirect=https://evil.example'), /SOURCE_URL_UNTRUSTED_ORIGIN/);
  assert.throws(() => canonicalizeKaiSourceUrl('https://kai.com/provider-a/status'), /SOURCE_URL_PATH_NOT_ALLOWED/);
});

test('transport contract is valid JSON and keeps execution behind an account key', async () => {
  const openapi = JSON.parse(await readFile(new URL('../openapi/kai-hour-key.openapi.json', import.meta.url)));
  const receipt = JSON.parse(await readFile(new URL('../schema/receipt.schema.json', import.meta.url)));
  assert.equal(openapi.openapi, '3.1.0');
  assert.ok(openapi.paths['/v1/compute'].post.security);
  assert.ok(openapi.paths['/v1/offers'].get.security);
  assert.ok(openapi.paths['/v1/holdings/lock'].post.parameters.some((p) => p.name === 'Idempotency-Key'));
  assert.ok(openapi.paths['/v1/compute'].post.parameters.some((p) => p.name === 'Idempotency-Key'));
  assert.deepEqual(openapi.paths['/v1/holdings/lock'].post.requestBody.content['application/json'].schema.required, ['offer_id', 'confirmed']);
  assert.deepEqual(openapi.paths['/v1/compute'].post.requestBody.content['application/json'].schema.required, ['holding_id', 'input']);
  assert.deepEqual(openapi.paths['/v1/compute'].post.responses['403'], { $ref: '#/components/responses/Denied' });
  assert.deepEqual(openapi.components.responses.Denied.content['application/json'].schema, { $ref: '../schema/runtime-error.schema.json' });
  assert.deepEqual(openapi.paths['/v1/holdings/lock'].post.responses['400'], { $ref: '#/components/responses/RuntimeError' });
  assert.deepEqual(openapi.paths['/v1/holdings/lock'].post.responses['404'], { $ref: '#/components/responses/RuntimeError' });
  assert.deepEqual(openapi.paths['/v1/compute'].post.responses['400'], { $ref: '#/components/responses/RuntimeError' });
  assert.equal(openapi.paths['/v1/offers'].get.responses['503'].description, 'KAI Offer catalog is temporarily unavailable');
  assert.equal(openapi.paths['/v1/receipts/{receipt_id}'].get.responses['404'].description, 'Receipt was not found');
  assert.equal(receipt.properties.idempotency_key.type, 'string');
  assert.ok(receipt.required.includes('idempotency_key'));
  assert.ok(receipt.required.includes('hour_key_status'));
});
