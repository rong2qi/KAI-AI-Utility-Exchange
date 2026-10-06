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
    maxRequests: 10,
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
    peakConcurrency: true,
  });
  assert.equal(evidence.results.successfulRequests, 10);
  assert.deepEqual(evidence.results.successfulRequestIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(evidence.results.rateLimitedRequests, 1);
  assert.deepEqual(evidence.results.rateLimitedRequestIndexes, [10]);
  assert.equal(evidence.results.usage.totalUnits, evidence.results.usage.inputUnits + evidence.results.usage.outputUnits);
  assert.equal(evidence.results.peakConcurrency, 10);
  assert.equal(evidence.scope.networkDisabled, true);
  assert.equal(evidence.scope.credentialsUsed, false);
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
