import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  XfyunProviderError,
  XfyunSparkProviderAdapter,
  XFYUN_SPARK_DEFAULT_ENDPOINT,
  createMacKeychainApiKeyResolver,
} from '../src/adapters/xfyun-spark-provider.mjs';

const request = (overrides = {}) => ({
  model: 'spark-x2.5',
  region: 'cn-huabei-1',
  input: {
    messages: [{ role: 'user', content: 'hello' }],
    user: 'local-smoke',
    thinking: { type: 'disabled' },
  },
  requestId: 'xfyun-request-1',
  idempotencyKey: 'xfyun-idem-1',
  ...overrides,
});

const response = (body, options = {}) => new Response(JSON.stringify(body), {
  status: options.status ?? 200,
  headers: { 'content-type': 'application/json' },
});

test('maps the documented Spark request and response into the Provider port', async () => {
  let captured;
  const adapter = new XfyunSparkProviderAdapter({
    apiKeyResolver: () => 'test-key',
    fetchImpl: async (url, options) => {
      captured = { url, options, payload: JSON.parse(options.body) };
      return response({
        code: 0,
        id: 'chatcmpl-test-1',
        model: 'spark-x2.5',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    },
  });

  const result = await adapter.execute(request());
  assert.equal(captured.url, XFYUN_SPARK_DEFAULT_ENDPOINT);
  assert.equal(captured.options.headers.authorization, 'Bearer test-key');
  assert.equal(captured.payload.model, 'spark-x2.5');
  assert.equal(captured.payload.stream, false);
  assert.deepEqual(result, {
    providerRequestId: 'chatcmpl-test-1',
    output: { content: '你好', reasoningContent: null, finishReason: 'stop', model: 'spark-x2.5' },
    usage: { inputUnits: 4, outputUnits: 2, totalUnits: 6 },
    status: 'succeeded',
  });
});

test('resolves a key from the injected resolver without exposing it in the result', async () => {
  let resolverCalls = 0;
  let authorization;
  const adapter = new XfyunSparkProviderAdapter({
    apiKeyResolver: async () => {
      resolverCalls += 1;
      return 'resolver-key';
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return response({ id: 'chatcmpl-2', choices: [{ message: { content: null } }] });
    },
  });

  await adapter.execute(request({ idempotencyKey: 'xfyun-resolver-1' }));
  assert.equal(resolverCalls, 1);
  assert.equal(authorization, 'Bearer resolver-key');
});

test('Keychain resolver returns a value without exposing the security command output', async () => {
  let command;
  const resolver = createMacKeychainApiKeyResolver({
    account: 'test-account',
    service: 'test-service',
    execFileImpl: (file, args, options, callback) => {
      command = { file, args, options };
      callback(null, 'keychain-test-value\n');
    },
  });
  assert.equal(await resolver(), 'keychain-test-value');
  assert.deepEqual(command, {
    file: 'security',
    args: ['find-generic-password', '-a', 'test-account', '-s', 'test-service', '-w'],
    options: { encoding: 'utf8' },
  });
});

test('rejects unsupported stream requests, models, and endpoints before network access', async () => {
  const fetchImpl = async () => {
    throw new Error('network should not be called');
  };
  assert.throws(() => new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'test-key', endpoint: 'https://example.test/v1', fetchImpl }), /XFYUN_ENDPOINT_NOT_ALLOWED/);
  const adapter = new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'test-key', fetchImpl });
  await assert.rejects(adapter.execute(request({ model: 'spark-unknown' })), (error) => error.code === 'PROVIDER_SCOPE_UNSUPPORTED');
  await assert.rejects(adapter.execute(request({ input: { messages: [{ role: 'user', content: 'hello' }], stream: true } })), (error) => error.code === 'REQUEST_STREAM_UNSUPPORTED');
});

test('does not turn a missing secret into a network call', async () => {
  const adapter = new XfyunSparkProviderAdapter({ apiKeyResolver: () => undefined, fetchImpl: async () => { throw new Error('network should not be called'); } });
  await assert.rejects(adapter.execute(request()), (error) => error instanceof XfyunProviderError && error.code === 'PROVIDER_CREDENTIAL_REQUIRED');
});

test('maps HTTP, business, malformed response, and timeout failures without leaking secrets', async () => {
  const httpError = new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'secret-key', fetchImpl: async () => response({ message: 'do not expose' }, { status: 503 }) });
  await assert.rejects(httpError.execute(request()), (error) => error.code === 'PROVIDER_HTTP_ERROR' && error.retryable === true && !error.message.includes('secret-key'));

  const businessError = new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'secret-key', fetchImpl: async () => response({ code: 10001, message: 'invalid key' }) });
  await assert.rejects(businessError.execute(request({ idempotencyKey: 'xfyun-business-1' })), (error) => error.code === 'PROVIDER_BUSINESS_ERROR' && error.retryable === false && !error.message.includes('invalid key'));

  const malformed = new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'secret-key', fetchImpl: async () => response({ code: 0, choices: [] }) });
  await assert.rejects(malformed.execute(request({ idempotencyKey: 'xfyun-malformed-1' })), (error) => error.code === 'PROVIDER_RESPONSE_INVALID');

  const timeout = new XfyunSparkProviderAdapter({ apiKeyResolver: () => 'secret-key', timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  await assert.rejects(timeout.execute(request({ idempotencyKey: 'xfyun-timeout-1' })), (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable === true);
});
