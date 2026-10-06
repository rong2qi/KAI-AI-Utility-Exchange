import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConcurrencyQuotaAcceptance } from '../src/concurrency-quota-acceptance.mjs';
import { QuotaSandboxProviderAdapter } from '../src/adapters/quota-sandbox-provider.mjs';

const request = (index) => ({
  model: 'model-a',
  region: 'region-a',
  input: { prompt: `quota-${index}`, temperature: 0 },
  requestId: `quota-request-${index}`,
  idempotencyKey: `quota-idempotency-${index}`,
});

test('acceptance harness proves ten concurrent requests and rejects the eleventh', async () => {
  const adapter = new QuotaSandboxProviderAdapter({
    maxConcurrent: 10,
    maxRequests: 100,
    sandboxOptions: { latencyMs: 15 },
  });

  const evidence = await runConcurrencyQuotaAcceptance({
    adapter,
    buildRequest: request,
    concurrencyLimit: 10,
  });

  assert.equal(evidence.status, 'passed');
  assert.deepEqual(evidence.checks, {
    successfulRequests: true,
    rateLimitedRequests: true,
    usageTotals: true,
  });
  assert.equal(evidence.results.successfulRequests, 10);
  assert.deepEqual(evidence.results.successfulRequestIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(evidence.results.rateLimitedRequests, 1);
  assert.deepEqual(evidence.results.rateLimitedRequestIndexes, [10]);
  assert.equal(evidence.results.usage.totalUnits, evidence.results.usage.inputUnits + evidence.results.usage.outputUnits);
  assert.equal(adapter.peakConcurrency, 10);
  assert.equal(adapter.active, 0);
});

test('acceptance harness reports a failed claim when the adapter does not enforce the limit', async () => {
  const adapter = new QuotaSandboxProviderAdapter({
    maxConcurrent: 11,
    maxRequests: 11,
    sandboxOptions: { latencyMs: 1 },
  });

  const evidence = await runConcurrencyQuotaAcceptance({
    adapter,
    buildRequest: request,
    concurrencyLimit: 10,
  });

  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.results.successfulRequests, 11);
  assert.equal(evidence.results.rateLimitedRequests, 0);
});

test('missing usage fails with structured evidence instead of crashing', async () => {
  const adapter = { execute: async () => ({ status: 'succeeded' }) };
  const evidence = await runConcurrencyQuotaAcceptance({ adapter, buildRequest: request, concurrencyLimit: 1 });
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.checks.usageTotals, false);
});

test('portable evaluation needs no private telemetry and cannot assert network isolation', async () => {
  let count = 0;
  const adapter = { async execute() {
    if (count++ === 1) throw Object.assign(new Error('private'), { code: 'PROVIDER_RATE_LIMITED', retryable: true });
    return { status: 'succeeded', usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 } };
  } };
  const evidence = await runConcurrencyQuotaAcceptance({ adapter, buildRequest: request, concurrencyLimit: 1 });
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.scope.networkDisabled, undefined);
  assert.equal(evidence.scope.credentialsUsed, undefined);
  assert.equal(evidence.checks.peakConcurrency, undefined);
});

test('untrusted error codes and unsafe aggregate usage never enter evidence', async () => {
  const secret = 'secret-sentinel';
  const hidden = await runConcurrencyQuotaAcceptance({
    adapter: { execute() { throw { code: secret, message: secret }; } },
    buildRequest: request, concurrencyLimit: 1,
  });
  assert.equal(JSON.stringify(hidden).includes(secret), false);
  const overflow = await runConcurrencyQuotaAcceptance({
    adapter: { execute: async () => ({ status: 'succeeded', usage: { inputUnits: Number.MAX_SAFE_INTEGER, outputUnits: 0, totalUnits: Number.MAX_SAFE_INTEGER } }) },
    buildRequest: request, concurrencyLimit: 2,
  });
  assert.equal(overflow.checks.usageTotals, false);
});
