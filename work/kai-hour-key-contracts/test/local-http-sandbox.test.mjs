import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  HttpProviderAdapter,
  ProviderHttpError,
  startLocalProviderSandbox,
} from '../src/adapters/local-http-provider.mjs';

const resources = [];
const request = (overrides = {}) => ({
  model: 'model-a',
  region: 'region-a',
  input: { prompt: 'hello', temperature: 0 },
  requestId: 'http-request-1',
  idempotencyKey: 'http-idempotency-1',
  ...overrides,
});

const open = async (options = {}) => {
  const resource = await startLocalProviderSandbox(options);
  resources.push(resource);
  return resource;
};

after(async () => {
  await Promise.all(resources.map((resource) => resource.close()));
});

test('HTTP adapter preserves successful replay semantics across the local boundary', async () => {
  const server = await open();
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint });

  const first = await adapter.execute(request());
  const replay = await adapter.execute(request({ requestId: 'http-request-retry' }));

  assert.equal(first.status, 'succeeded');
  assert.deepEqual(replay, first);
});

test('HTTP 503 keeps a transient Provider failure retryable', async () => {
  const server = await open({ profile: 'transient_failure' });
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint });

  await assert.rejects(
    adapter.execute(request({ idempotencyKey: 'http-transient-1' })),
    (error) => error instanceof ProviderHttpError
      && error.code === 'PROVIDER_TRANSIENT'
      && error.retryable === true,
  );
  const recovered = await adapter.execute(request({ idempotencyKey: 'http-transient-1', requestId: 'http-transient-retry' }));
  assert.equal(recovered.status, 'succeeded');
});

test('transport timeout is surfaced as a retryable timeout', async () => {
  const server = await open({ latencyMs: 80, timeoutMs: 500 });
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint, timeoutMs: 10 });

  await assert.rejects(
    adapter.execute(request({ idempotencyKey: 'http-timeout-1' })),
    (error) => error instanceof ProviderHttpError
      && error.code === 'PROVIDER_TIMEOUT'
      && error.retryable === true,
  );
});

test('malformed HTTP response stays visible for Runtime and Usage Ledger to reject', async () => {
  const server = await open({ profile: 'malformed_result' });
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint });

  const result = await adapter.execute(request({ idempotencyKey: 'http-malformed-1' }));

  assert.equal(result.status, 'unknown');
  assert.equal(result.usage, undefined);
});

test('HTTP scope error prevents an unsupported resource from executing', async () => {
  const server = await open();
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint });

  await assert.rejects(
    adapter.execute(request({ model: 'model-outside', idempotencyKey: 'http-scope-1' })),
    (error) => error.code === 'PROVIDER_SCOPE_UNSUPPORTED' && error.retryable === false,
  );
});

test('HTTP server rejects non-JSON requests and unknown paths', async () => {
  const server = await open();

  const contentTypeResponse = await fetch(`${server.endpoint}/v1/execute`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not-json',
  });
  assert.equal(contentTypeResponse.status, 415);
  assert.equal((await contentTypeResponse.json()).code, 'CONTENT_TYPE_UNSUPPORTED');

  const routeResponse = await fetch(`${server.endpoint}/unknown`, { method: 'POST' });
  assert.equal(routeResponse.status, 404);
  assert.equal((await routeResponse.json()).code, 'ROUTE_NOT_FOUND');
});

test('HTTP server rejects an oversized request body', async () => {
  const server = await open();
  const response = await fetch(`${server.endpoint}/v1/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request({ idempotencyKey: 'http-large-1' }), input: 'x'.repeat(70_000) }),
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'REQUEST_TOO_LARGE');
});

test('HTTP adapter rejects external endpoints and reports a closed sandbox as unavailable', async () => {
  assert.throws(() => new HttpProviderAdapter({ endpoint: 'https://api.example.test' }), /LOCAL_PROVIDER_ENDPOINT_REQUIRED/);
  const server = await open();
  const adapter = new HttpProviderAdapter({ endpoint: server.endpoint, timeoutMs: 100 });
  await server.close();

  await assert.rejects(
    adapter.execute(request({ idempotencyKey: 'http-closed-1' })),
    (error) => error instanceof ProviderHttpError
      && error.code === 'PROVIDER_UNAVAILABLE'
      && error.retryable === true,
  );
});
