import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateIntent } from '../src/policy.mjs';

const slot = {
  slotStart: '2026-10-07T06:00:00.000Z', lockDeadline: '2026-10-07T05:55:00.000Z',
  slotEnd: '2026-10-07T07:00:00.000Z', timeZone: 'Asia/Shanghai',
};
const key = {
  accountId: 'account-local', grantIds: ['grant-hour'],
  expiresAt: '2026-11-06T06:00:00.000Z', receiptUntil: '2026-11-07T06:00:00.000Z',
};
const grant = {
  accountId: key.accountId, grantId: 'grant-hour', scopeEpoch: 1,
  resourceScope: { models: ['model-a'], providers: ['sandbox'], regions: ['local'] },
  capabilityScope: ['compute', 'usage.receipt'], slot,
  issuedAt: slot.slotStart, expiresAt: slot.slotEnd, receiptUntil: '2026-10-08T07:00:00.000Z',
};
const requestedResource = { model: 'model-a', provider: 'sandbox', region: 'local' };
const evaluate = (overrides = {}) => evaluateIntent({
  now: slot.slotEnd, key, grants: [grant], intent: { kind: 'compute' }, requestedResource,
  ...overrides,
});

test('a valid account Key with an expired matching hourly Grant reports expiry', () => {
  const explicit = evaluate();
  const implicit = evaluate({ requestedResource: {} });
  assert.equal(explicit.allowed, false);
  assert.equal(explicit.code, 'DENY_EXPIRED');
  assert.equal(implicit.allowed, false);
  assert.equal(implicit.code, 'DENY_EXPIRED');
});

test('a genuinely out-of-scope resource remains a scope expansion request', () => {
  const decision = evaluate({ requestedResource: { ...requestedResource, model: 'another-model' } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'SCOPE_EXPANSION_REQUIRED');
});

test('an expired matching Grant stays expired when a different scope has an active Grant', () => {
  const other = {
    ...grant, grantId: 'grant-other', expiresAt: '2026-10-07T08:00:00.000Z',
    resourceScope: { ...grant.resourceScope, models: ['another-model'] },
  };
  const decision = evaluate({ key: { ...key, grantIds: [...key.grantIds, other.grantId] }, grants: [grant, other] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'DENY_EXPIRED');
});

test('unrelated Grants cannot mask the matching scope expiry or revocation diagnosis', () => {
  const other = {
    ...grant, grantId: 'grant-other', resourceScope: { ...grant.resourceScope, models: ['another-model'] },
    revokedAt: '2026-10-07T06:30:00.000Z',
  };
  const multiGrantKey = { ...key, grantIds: [...key.grantIds, other.grantId] };
  const expired = evaluate({ key: multiGrantKey, grants: [grant, other] });
  assert.equal(expired.allowed, false);
  assert.equal(expired.code, 'DENY_EXPIRED');
  const activeOther = { ...other, revokedAt: undefined, expiresAt: '2026-10-07T08:00:00.000Z' };
  const revoked = evaluate({ key: multiGrantKey, grants: [{ ...grant, revokedAt: other.revokedAt }, activeOther] });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.code, 'DENY_REVOKED');
  const outside = evaluate({ key: multiGrantKey, grants: [grant, other], requestedResource: { model: 'third-model' } });
  assert.equal(outside.allowed, false);
  assert.equal(outside.code, 'SCOPE_EXPANSION_REQUIRED');
});

test('diagnosing an expired Grant does not grant a missing capability or bypass revocation', () => {
  const missingCapability = evaluate({ requestedResource: {}, grants: [{ ...grant, capabilityScope: ['usage.receipt'] }] });
  assert.equal(missingCapability.allowed, false);
  assert.equal(missingCapability.code, 'DENY_CAPABILITY');
  const revoked = evaluate({ grants: [{ ...grant, revokedAt: '2026-10-07T06:30:00.000Z' }] });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.code, 'DENY_REVOKED');
});

test('Receipt uses its own retention window before eventually reporting expiry', () => {
  const withinRetention = evaluate({ intent: { kind: 'receipt' }, requestedResource: {} });
  assert.equal(withinRetention.allowed, true);
  const expired = evaluate({ now: grant.receiptUntil, intent: { kind: 'receipt' }, requestedResource: {} });
  assert.equal(expired.allowed, false);
  assert.equal(expired.code, 'DENY_EXPIRED');
});
