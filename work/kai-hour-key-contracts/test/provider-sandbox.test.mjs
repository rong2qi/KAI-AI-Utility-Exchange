import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProviderSandboxError,
  SandboxProviderAdapter,
} from '../src/adapters/sandbox-provider.mjs';

const request = (overrides = {}) => ({
  model: 'model-a',
  region: 'region-a',
  input: { prompt: 'hello', temperature: 0 },
  requestId: 'request-1',
  idempotencyKey: 'idem-sandbox-1',
  ...overrides,
});

test('internal sandbox returns a deterministic successful Provider result', async () => {
  const adapter = new SandboxProviderAdapter();

  const result = await adapter.execute(request());

  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerRequestId, 'sandbox-provider-v1_be3ce18c48e56519');
  assert.deepEqual(result.output, {
    providerId: 'sandbox-provider-v1',
    model: 'model-a',
    region: 'region-a',
    echo: { prompt: 'hello', temperature: 0 },
  });
  assert.equal(result.usage.totalUnits, result.usage.inputUnits + result.usage.outputUnits);
});

test('same idempotency key and request facts replay the same result across request ids', async () => {
  const adapter = new SandboxProviderAdapter();

  const first = await adapter.execute(request({ requestId: 'request-first' }));
  const replay = await adapter.execute(request({ requestId: 'request-retry' }));

  assert.deepEqual(replay, first);
  assert.equal(adapter.executions, 1);
  assert.equal(adapter.calls, 2);
});

test('same idempotency key with different request facts is rejected', async () => {
  const adapter = new SandboxProviderAdapter();
  await adapter.execute(request());

  await assert.rejects(
    adapter.execute(request({ input: { prompt: 'changed', temperature: 0 } })),
    (error) => error instanceof ProviderSandboxError
      && error.code === 'IDEMPOTENCY_CONFLICT'
      && error.retryable === false,
  );
  assert.equal(adapter.executions, 1);
});

test('transient sandbox failure can recover on the next attempt', async () => {
  const adapter = new SandboxProviderAdapter({ profile: 'transient_failure' });

  await assert.rejects(
    adapter.execute(request()),
    (error) => error.code === 'PROVIDER_TRANSIENT' && error.retryable === true,
  );
  const recovered = await adapter.execute(request({ requestId: 'request-retry' }));

  assert.equal(recovered.status, 'succeeded');
  assert.equal(adapter.executions, 1);
});

test('timeout profile returns a retryable provider timeout', async () => {
  const adapter = new SandboxProviderAdapter({ profile: 'timeout' });

  await assert.rejects(
    adapter.execute(request()),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable === true,
  );
  assert.equal(adapter.executions, 0);
});

test('model and region outside the configured sandbox scope are rejected', async () => {
  const adapter = new SandboxProviderAdapter();

  await assert.rejects(
    adapter.execute(request({ model: 'model-outside' })),
    (error) => error.code === 'PROVIDER_SCOPE_UNSUPPORTED' && error.retryable === false,
  );
  await assert.rejects(
    adapter.execute(request({ region: 'region-outside', idempotencyKey: 'idem-sandbox-2' })),
    (error) => error.code === 'PROVIDER_SCOPE_UNSUPPORTED' && error.retryable === false,
  );
});

test('malformed profile stays visibly malformed for the caller to reject', async () => {
  const adapter = new SandboxProviderAdapter({ profile: 'malformed_result' });

  const result = await adapter.execute(request());

  assert.equal(result.status, 'unknown');
  assert.equal(result.usage, undefined);
});
