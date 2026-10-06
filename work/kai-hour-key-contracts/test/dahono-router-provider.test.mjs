import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DahonoProviderError,
  DahonoRouterProviderAdapter,
  DAHONO_ROUTER_DEFAULT_ENDPOINT,
  DAHONO_ROUTER_MODEL,
} from '../src/adapters/dahono-router-provider.mjs';

const diagnostics = {
  'x-dahono-slot-id': 'slot-test',
  'x-dahono-server-region': 'region-test',
  'x-dahono-concurrency-active': '1',
  'x-dahono-concurrency-remaining': '9',
  'x-dahono-remaining-rpm': '8',
  'x-dahono-hourly-req-remaining': '599',
  'x-dahono-hourly-tokens-input': '20',
  'x-dahono-hourly-tokens-output': '30',
};

const request = (overrides = {}) => ({
  model: DAHONO_ROUTER_MODEL,
  region: 'dahono-global',
  input: {
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0,
  },
  requestId: 'dahono-request-1',
  idempotencyKey: 'dahono-idem-1',
  ...overrides,
});

const sseResponse = (events, options = {}) => {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: options.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...diagnostics, ...(options.headers ?? {}) },
  });
};

const adapterWith = (fetchImpl, options = {}) => new DahonoRouterProviderAdapter({
  apiKeyResolver: () => 'test-secret-key',
  fetchImpl,
  networkMode: 'live',
  ...options,
});

test('maps an OpenAI-compatible SSE response and diagnostics into the Provider port', async () => {
  let captured;
  const adapter = adapterWith(async (url, options) => {
    captured = { url, options, payload: JSON.parse(options.body) };
    return sseResponse([
      { id: 'chatcmpl-dahono-1', model: DAHONO_ROUTER_MODEL, choices: [{ delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
      { id: 'chatcmpl-dahono-1', choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] },
      { id: 'chatcmpl-dahono-1', choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]);
  });

  const result = await adapter.execute(request());
  assert.equal(captured.url, DAHONO_ROUTER_DEFAULT_ENDPOINT);
  assert.equal(captured.options.headers.authorization, 'Bearer test-secret-key');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.payload.model, DAHONO_ROUTER_MODEL);
  assert.equal(captured.payload.stream, true);
  assert.deepEqual(captured.payload.messages, request().input.messages);
  assert.deepEqual(result, {
    providerRequestId: 'chatcmpl-dahono-1',
    output: {
      content: '你好',
      reasoningContent: null,
      finishReason: 'stop',
      model: DAHONO_ROUTER_MODEL,
    },
    usage: { inputUnits: 4, outputUnits: 2, totalUnits: 6 },
    diagnostics: {
      slotId: 'slot-test',
      serverRegion: 'region-test',
      concurrencyActive: 1,
      concurrencyRemaining: 9,
      remainingRpm: 8,
      hourlyReqRemaining: 599,
      hourlyTokensInput: 20,
      hourlyTokensOutput: 30,
    },
    status: 'succeeded',
  });
});

test('resolves the key inside the adapter and never exposes it in result or errors', async () => {
  let resolverCalls = 0;
  let authorization;
  const adapter = adapterWith(async (_url, options) => {
    authorization = options.headers.authorization;
    return sseResponse([
      { id: 'chatcmpl-dahono-2', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }, {
    apiKeyResolver: async () => {
      resolverCalls += 1;
      return 'resolver-secret';
    },
  });
  const result = await adapter.execute(request({ idempotencyKey: 'dahono-resolver-1' }));
  assert.equal(resolverCalls, 1);
  assert.equal(authorization, 'Bearer resolver-secret');
  assert.equal(JSON.stringify(result).includes('resolver-secret'), false);

  const failure = adapterWith(async () => new Response(JSON.stringify({ error: { message: 'resolver-secret leaked upstream' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  }), { apiKeyResolver: () => 'resolver-secret' });
  await assert.rejects(failure.execute(request({ idempotencyKey: 'dahono-secret-1' })), (error) => {
    assert.equal(error.code, 'PROVIDER_CREDENTIAL_INVALID');
    assert.equal(error.message.includes('resolver-secret'), false);
    assert.equal(JSON.stringify(error).includes('resolver-secret'), false);
    return true;
  });
});

test('rejects unsupported endpoint, scope, malformed input, and missing credentials before network access', async () => {
  const fetchImpl = async () => { throw new Error('network should not be called'); };
  assert.throws(() => new DahonoRouterProviderAdapter({ apiKeyResolver: () => 'key', endpoint: 'https://example.test/v1/chat/completions', fetchImpl }), /DAHONO_ENDPOINT_NOT_ALLOWED/);
  assert.throws(() => new DahonoRouterProviderAdapter({ apiKeyResolver: () => 'key', endpoint: 'https://user:pass@kai.dahono.com/v1/chat/completions', fetchImpl }), /DAHONO_ENDPOINT_NOT_ALLOWED/);
  assert.throws(() => new DahonoRouterProviderAdapter({ apiKeyResolver: () => 'key', endpoint: 'https://kai.dahono.com:444/v1/chat/completions', fetchImpl }), /DAHONO_ENDPOINT_NOT_ALLOWED/);
  const adapter = new DahonoRouterProviderAdapter({ apiKeyResolver: () => 'key', fetchImpl, networkMode: 'live' });
  await assert.rejects(adapter.execute(request({ model: 'other-model' })), (error) => error.code === 'PROVIDER_SCOPE_UNSUPPORTED');
  await assert.rejects(adapter.execute(request({ input: { messages: [] }, idempotencyKey: 'dahono-invalid-1' })), (error) => error.code === 'REQUEST_INVALID');
  const missing = new DahonoRouterProviderAdapter({ apiKeyResolver: () => undefined, fetchImpl, networkMode: 'live' });
  await assert.rejects(missing.execute(request({ idempotencyKey: 'dahono-missing-1' })), (error) => error.code === 'PROVIDER_CREDENTIAL_REQUIRED');
});

const assertInvalidSse = async (events, idempotencyKey) => {
  const adapter = adapterWith(async () => sseResponse(events));
  await assert.rejects(adapter.execute(request({ idempotencyKey })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');
};

test('keeps SSE identity stable, rejects model changes and multiple choices, and requires a final finish reason', async () => {
  await assertInvalidSse([
    { id: 'first', model: DAHONO_ROUTER_MODEL, choices: [{ delta: { content: 'a' }, finish_reason: null }] },
    { id: 'second', choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ], 'dahono-id-change-1');
  await assertInvalidSse([
    { id: 'model-change', model: 'other-model', choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ], 'dahono-model-change-1');
  await assertInvalidSse([
    { id: 'multi-choice', model: DAHONO_ROUTER_MODEL, choices: [
      { delta: { content: 'a' }, finish_reason: null },
      { delta: { content: 'b' }, finish_reason: null },
    ] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ], 'dahono-multi-choice-1');
  await assertInvalidSse([
    { id: 'missing-finish', model: DAHONO_ROUTER_MODEL, choices: [{ delta: { content: 'a' }, finish_reason: null }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ], 'dahono-missing-finish-1');
});

test('allows usage:null intermediate blocks but requires safe, consistent final usage', async () => {
  const adapter = adapterWith(async () => sseResponse([
    { id: 'usage-null', model: DAHONO_ROUTER_MODEL, choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'usage-null', usage: null, choices: [] },
    { id: 'usage-null', choices: [{ delta: {}, finish_reason: 'stop' }] },
    { id: 'usage-null', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]));
  const result = await adapter.execute(request({ idempotencyKey: 'dahono-usage-null-1' }));
  assert.deepEqual(result.usage, { inputUnits: 1, outputUnits: 1, totalUnits: 2 });
  await assertInvalidSse([
    { id: 'unsafe-usage', choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 2 } },
  ], 'dahono-unsafe-usage-1');
  await assertInvalidSse([
    { id: 'mismatched-usage', choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 } },
  ], 'dahono-mismatched-usage-1');
});

test('default construction is network-disabled and does not read a key or call fetch', async () => {
  let resolved = false;
  const adapter = new DahonoRouterProviderAdapter({ apiKeyResolver: () => { resolved = true; return 'key'; }, fetchImpl: async () => { throw new Error('network should not be called'); } });
  await assert.rejects(adapter.execute(request()), (error) => error.code === 'PROVIDER_NETWORK_DISABLED');
  assert.equal(resolved, false);
});

test('classifies credential, reservation-window, rate-limit, and upstream failures safely', async () => {
  const cases = [
    [401, 'PROVIDER_CREDENTIAL_INVALID', false, undefined],
    [403, 'PROVIDER_WINDOW_CLOSED', false, '403_OUTSIDE_RESERVED_WINDOW'],
    [403, 'PROVIDER_HTTP_ERROR', false, '403_OTHER'],
    [429, 'PROVIDER_RATE_LIMITED', true, undefined],
    [503, 'PROVIDER_HTTP_ERROR', true, undefined],
    [400, 'PROVIDER_HTTP_ERROR', false, undefined],
  ];
  for (const [status, code, retryable, upstreamCode] of cases) {
    const adapter = adapterWith(async () => new Response(JSON.stringify({ error: { code: upstreamCode ?? 'upstream-secret-code', message: 'upstream-secret-message' } }), {
      status,
      headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '2' } : {}) },
    }));
    await assert.rejects(adapter.execute(request({ idempotencyKey: `dahono-http-${status}` })), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      assert.equal(status === 429 ? error.retryAfter : undefined, status === 429 ? 2 : undefined);
      assert.equal(error.message.includes('upstream-secret'), false);
      return true;
    });
  }
});

test('maps aborts to a retryable timeout and rejects malformed SSE or missing usage', async () => {
  const timeout = adapterWith(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { timeoutMs: 5 });
  await assert.rejects(timeout.execute(request({ idempotencyKey: 'dahono-timeout-1' })), (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable === true);

  const hangingStream = adapterWith(async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream', ...diagnostics }),
    body: { [Symbol.asyncIterator]() { return { next: async () => new Promise(() => {}) }; } },
  }), { timeoutMs: 5 });
  await assert.rejects(hangingStream.execute(request({ idempotencyKey: 'dahono-timeout-stream-1' })), (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable === true);

  const malformed = adapterWith(async () => new Response('data: {"id":"x","choices":[]}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...diagnostics },
  }));
  await assert.rejects(malformed.execute(request({ idempotencyKey: 'dahono-malformed-1' })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');

  const missingUsage = adapterWith(async () => sseResponse([
    { id: 'chatcmpl-no-usage', choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] },
  ]));
  await assert.rejects(missingUsage.execute(request({ idempotencyKey: 'dahono-missing-usage-1' })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');
});

const trackedReadableResponse = ({ status = 200, chunks = [], pending = false } = {}) => {
  const state = { cancelCalls: 0, releaseCalls: 0, readCalls: 0 };
  let cursor = 0;
  const reader = {
    async read() {
      state.readCalls += 1;
      if (pending) return new Promise(() => {});
      if (cursor >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: Buffer.from(chunks[cursor++]) };
    },
    async cancel() {
      state.cancelCalls += 1;
    },
    releaseLock() {
      state.releaseCalls += 1;
    },
  };
  return {
    state,
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers({ 'content-type': status === 200 ? 'text/event-stream' : 'application/json', ...diagnostics }),
      body: { getReader: () => reader },
    },
  };
};

test('cancels and releases response readers on malformed, oversized, timeout, and HTTP-error paths', async () => {
  const malformed = trackedReadableResponse({ chunks: ['data: {"id":"bad","choices":[]}\n\n', 'data: [DONE]\n\n'] });
  const malformedAdapter = adapterWith(async () => malformed.response);
  await assert.rejects(malformedAdapter.execute(request({ idempotencyKey: 'dahono-release-malformed-1' })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');
  assert.ok(malformed.state.cancelCalls > 0);
  assert.ok(malformed.state.releaseCalls > 0);

  const oversized = trackedReadableResponse({ chunks: ['x'.repeat(1024)] });
  const oversizedAdapter = adapterWith(async () => oversized.response, { maxResponseBytes: 16 });
  await assert.rejects(oversizedAdapter.execute(request({ idempotencyKey: 'dahono-release-oversized-1' })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');
  assert.ok(oversized.state.cancelCalls > 0);
  assert.ok(oversized.state.releaseCalls > 0);

  const timeout = trackedReadableResponse({ pending: true });
  const timeoutAdapter = adapterWith(async () => timeout.response, { timeoutMs: 5 });
  await assert.rejects(timeoutAdapter.execute(request({ idempotencyKey: 'dahono-release-timeout-1' })), (error) => error.code === 'PROVIDER_TIMEOUT');
  assert.ok(timeout.state.cancelCalls > 0);
  assert.ok(timeout.state.releaseCalls > 0);

  const httpError = trackedReadableResponse({ status: 503, chunks: ['upstream body'] });
  const httpAdapter = adapterWith(async () => httpError.response);
  await assert.rejects(httpAdapter.execute(request({ idempotencyKey: 'dahono-release-http-1' })), (error) => error.code === 'PROVIDER_HTTP_ERROR');
  assert.ok(httpError.state.cancelCalls > 0);
  assert.ok(httpError.state.releaseCalls > 0);
});

test('accepts prompt input and keeps optional request parameters bounded', async () => {
  let payload;
  const adapter = adapterWith(async (_url, options) => {
    payload = JSON.parse(options.body);
    return sseResponse([
      { id: 'chatcmpl-options', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  });
  await adapter.execute(request({ input: { prompt: 'hello', temperature: 0.2, max_tokens: 20, user: 'safe_user' }, idempotencyKey: 'dahono-options-1' }));
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.max_tokens, 20);
  assert.equal(payload.user, 'safe_user');
  assert.equal('prompt' in payload, false);
});

assert.ok(DahonoProviderError);
