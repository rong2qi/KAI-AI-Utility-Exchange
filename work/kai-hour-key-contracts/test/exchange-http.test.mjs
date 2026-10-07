import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createExchangeServer } from '../src/exchange-http.mjs';
import { createExchangeSandbox } from '../src/exchange-sandbox.mjs';

const KEY = 'exchange-test-only-secret';
const start = async (t, runtime, options = {}) => {
  const server = createExchangeServer({ runtime, ...options });
  await server.listen();
  t.after(() => server.close());
  return server;
};
const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'idempotency-key': 'request-0001' };
const compute = (server, body, changes = {}) => fetch(`${server.address()}/v1/compute`, {
  method: 'POST', headers, body: JSON.stringify(body), ...changes,
});

test('missing account credential is rejected at HTTP without touching Runtime', async (t) => {
  let calls = 0;
  const server = await start(t, { handle: async () => { calls++; throw new Error(KEY); } });
  const response = await compute(server, { holding_id: 'holding', input: 'hello' }, { headers: {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'KEY_INVALID');
  assert.equal(calls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Exchange HTTP returns output, deducts once, replays and privately reads its receipt', async (t) => {
  const sandbox = createExchangeSandbox({ opaqueKey: KEY, units: 1 });
  const server = await start(t, sandbox.runtime);
  const body = { holding_id: sandbox.fixture.holdingId, input: '请解释购买与receipt这几个词' };
  const first = await compute(server, body);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.output.echo, body.input);
  assert.equal(result.receipt.holding_id, body.holding_id);
  assert.equal(result.receipt.accountId, undefined);
  const replay = await compute(server, body);
  assert.deepEqual(await replay.json(), result);
  const receipt = await fetch(`${server.address()}/v1/receipts/${result.receipt.receipt_id}`, { headers });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), result.receipt);
  const privateRead = await fetch(`${server.address()}/v1/receipts/${result.receipt.receipt_id}`, { headers: { authorization: 'Bearer wrong-key' } });
  assert.equal(privateRead.status, 401);
  assert.deepEqual(sandbox.inspect(), { providerCalls: 1, providerExecutions: 1, unitsRemaining: 0, receiptCount: 1 });
});

const raw = (server, path, options, chunks = []) => new Promise((resolve, reject) => {
  const request = httpRequest(`${server.address()}${path}`, options, (response) => {
    let text = '';
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  });
  request.on('error', reject);
  for (const chunk of chunks) request.write(chunk);
  request.end();
});

test('malformed transport or fields fail before Runtime, including duplicate headers and chunked overflow', async (t) => {
  let calls = 0;
  const server = await start(t, { handle: async () => { calls++; } }, { maxBodyBytes: 128 });
  const cases = [
    [{ holding_id: 'h', input: 'x', account_id: 'attacker' }, {}, 400],
    [{ holding_id: 'h', input: 'x', confirmed: true }, {}, 400],
    [[], {}, 400],
    [null, {}, 400],
    [{ holding_id: 'h', input: 'x' }, { headers: { ...headers, 'idempotency-key': 'bad' } }, 400],
    [{ holding_id: 'h', input: 'x' }, { headers: { ...headers, 'content-type': 'text/plain' } }, 415],
    [{ holding_id: 'h', input: 'x' }, { headers: { ...headers, 'content-encoding': 'gzip' } }, 415],
  ];
  for (const [body, changes, status] of cases) assert.equal((await compute(server, body, changes)).status, status);
  for (const value of ['{"holding_id":"h","input":', '{"holding_id":"h","input":1e999}']) {
    assert.equal((await raw(server, '/v1/compute', { method: 'POST', headers }, [value])).status, 400);
  }
  assert.equal((await raw(server, '/v1/compute', { method: 'POST', headers }, [Buffer.from([0xff])])).status, 400);
  assert.equal((await raw(server, '/v1/compute', { method: 'POST', headers }, ['x'.repeat(80), 'x'.repeat(80)])).status, 413);
  for (const name of ['Authorization', 'Idempotency-Key']) {
    const duplicated = ['Host', new URL(server.address()).host, ...Object.entries(headers).flat()].concat([name, name === 'Authorization' ? `Bearer ${KEY}` : 'request-0001']);
    assert.equal((await raw(server, '/v1/compute', { method: 'POST', headers: duplicated }, ['{}'])).status, name === 'Authorization' ? 401 : 400);
  }
  assert.equal((await fetch(`${server.address()}/v1/compute?key=bad`, { headers })).status, 404);
  assert.equal((await fetch(`${server.address()}/v1/compute`, { headers })).status, 405);
  assert.equal(calls, 0);
});

test('timeout retains admission until actual Runtime settlement; local busy is 503, not provider 429', async (t) => {
  let settle;
  let calls = 0;
  const runtime = { handle: () => { calls++; return new Promise((resolve) => { settle = resolve; }); } };
  const server = await start(t, runtime, { executionTimeoutMs: 25, maxConcurrentRequests: 1 });
  const timeout = await compute(server, { holding_id: 'h', input: 'x' });
  assert.equal(timeout.status, 504);
  const busy = await compute(server, { holding_id: 'h', input: 'x' });
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).code, 'EXCHANGE_BUSY');
  assert.equal(calls, 1);
  settle({ kind: 'error', error: { code: 'REQUEST_INVALID' } });
  await new Promise((resolve) => setImmediate(resolve));
});

test('unexpected Runtime errors expose neither secret nor stack', async (t) => {
  const server = await start(t, { handle: async () => { throw new Error(`private: ${KEY}`); } });
  const response = await compute(server, { holding_id: 'h', input: 'x' });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes('stack'), false);
});

test('configuration rejects public binding and invalid resource bounds', () => {
  const runtime = { handle: async () => {} };
  for (const options of [{ host: '0.0.0.0' }, { port: -1 }, { maxConcurrentRequests: 0 }, { maxBodyBytes: 0 }, { executionTimeoutMs: NaN }]) {
    assert.throws(() => createExchangeServer({ runtime, ...options }), /EXCHANGE_CONFIG_INVALID/);
  }
});

test('URL-encoded receipt identifiers can be read and encoded separators are rejected', async (t) => {
  const sandbox = createExchangeSandbox({ opaqueKey: KEY });
  const server = await start(t, sandbox.runtime);
  const response = await compute(server, { holding_id: sandbox.fixture.holdingId, input: 'hello' }, { headers: { ...headers, 'idempotency-key': 'receipt:encoded:01' } });
  const result = await response.json();
  const encoded = await fetch(`${server.address()}/v1/receipts/${encodeURIComponent(result.receipt.receipt_id)}`, { headers });
  assert.equal(encoded.status, 200);
  assert.deepEqual(await encoded.json(), result.receipt);
  for (const bad of ['%ZZ', 'a%2Fb', '..%2Fsecret', 'a?key=private']) {
    assert.equal((await fetch(`${server.address()}/v1/receipts/${bad}`, { headers })).status, 404);
  }
});

test('expired, out-of-scope, exhausted and conflicting requests have distinct safe HTTP results', async (t) => {
  let now = '2026-10-07T02:10:00.000Z';
  const sandbox = createExchangeSandbox({ opaqueKey: KEY, units: 1, now: () => now });
  const server = await start(t, sandbox.runtime);
  const body = { holding_id: sandbox.fixture.holdingId, input: 'hello' };
  const forbidden = await compute(server, { ...body, provider: 'unauthorized' });
  assert.equal(forbidden.status, 403);
  assert.equal(sandbox.inspect().providerCalls, 0);
  const success = await (await compute(server, body)).json();
  const conflict = await compute(server, { ...body, input: 'changed' });
  assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
  const exhausted = await compute(server, body, { headers: { ...headers, 'idempotency-key': 'request-0002' } });
  assert.equal((await exhausted.json()).code, 'HOLDING_EXHAUSTED');
  now = '2026-10-07T03:00:00.000Z';
  const expired = await compute(server, body);
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'AUTHORIZATION_EXPIRED');
  const receipt = await fetch(`${server.address()}/v1/receipts/${success.receipt.receipt_id}`, { headers });
  assert.equal(receipt.status, 200);
  assert.equal(sandbox.inspect().providerCalls, 1);
});

test('slow or over-deep request bodies fail before execution', async (t) => {
  let calls = 0;
  const server = await start(t, { handle: async () => { calls++; } }, { bodyTimeoutMs: 25 });
  let deep = 'end';
  for (let i = 0; i < 34; i++) deep = [deep];
  assert.equal((await compute(server, { holding_id: 'h', input: deep })).status, 400);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${server.address()}/v1/compute`, { method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', () => { request.destroy(); resolve(response.statusCode); });
    });
    request.on('error', reject);
    request.write('{');
  });
  assert.equal(status, 408);
  assert.equal(calls, 0);
});

test('client disconnect does not free a still-running execution permit', async (t) => {
  let entered;
  let settle;
  const admission = new Promise((resolve) => { entered = resolve; });
  const server = await start(t, { handle: async () => { entered(); return new Promise((resolve) => { settle = resolve; }); } }, { maxConcurrentRequests: 1 });
  const controller = new AbortController();
  const pending = compute(server, { holding_id: 'h', input: 'x' }, { signal: controller.signal }).catch(() => undefined);
  await admission;
  controller.abort();
  await pending;
  const busy = await compute(server, { holding_id: 'h', input: 'x' });
  assert.equal(busy.status, 503);
  settle({ kind: 'error', error: { code: 'REQUEST_INVALID' } });
  await new Promise((resolve) => setImmediate(resolve));
});

test('Receipt wire schema and nested allowlists exclude adapter-private properties', async (t) => {
  const sandbox = createExchangeSandbox({ opaqueKey: KEY });
  const runtime = { handle: async (command) => {
    const result = await sandbox.runtime.handle(command);
    if (result.kind === 'receipt') {
      result.receipt.secret = 'PRIVATE_ADAPTER_MARKER';
      for (const name of ['resource', 'slot', 'usage']) result.receipt[name].secret = 'PRIVATE_ADAPTER_MARKER';
    }
    return result;
  } };
  const server = await start(t, runtime);
  const response = await compute(server, { holding_id: sandbox.fixture.holdingId, input: 'hello' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('PRIVATE_ADAPTER_MARKER'), false);
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../schema/receipt.schema.json', import.meta.url)));
  const computeSchema = JSON.parse(await readFile(new URL('../schema/compute-result.schema.json', import.meta.url)));
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result).sort(), computeSchema.required.toSorted());
  assert.deepEqual(Object.keys(result.receipt).sort(), schema.required.toSorted());
  assert.equal(computeSchema.properties.receipt.$ref, schema.$id);
});
