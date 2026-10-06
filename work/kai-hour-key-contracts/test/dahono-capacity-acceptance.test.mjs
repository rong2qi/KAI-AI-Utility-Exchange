import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runDahonoCapacityAcceptance } from '../src/dahono-capacity-acceptance.mjs';

const START = '2026-10-06T10:00:00+08:00';
const END = '2026-10-06T11:00:00+08:00';
const bookedSlotHash = createHash('sha256').update('private-slot').digest('hex');
const options = { confirmLive: true, windowStart: START, windowEnd: END, expectedSlotIdHash: bookedSlotHash, now: () => Date.parse(START) + 1000 };

test('confirmation, explicit one-hour active window and credentials gate all network access', async () => {
  let credentials = 0;
  let network = 0;
  const deps = { apiKeyResolver: () => { credentials++; return 'secret'; }, fetchImpl: () => { network++; throw new Error('unexpected'); } };
  for (const change of [{ confirmLive: false }, { confirmLive: 'false' }, { windowStart: '2026-02-30T10:00:00+08:00', windowEnd: '2026-02-30T11:00:00+08:00', now: () => Date.parse('2026-03-02T10:00:01+08:00') }, { windowStart: '2026-10-06T10:00:00' }, { windowEnd: '2026-10-06T10:59:00+08:00' }, { now: () => Date.parse(END) - 299999 }, { now: () => Date.parse(START) - 1 }]) {
    const result = await runDahonoCapacityAcceptance({ ...options, ...deps, ...change });
    assert.equal(result.status, 'blocked');
    assert.equal(result.scope.networkUsed, false);
  }
  assert.equal(credentials, 0);
  assert.equal(network, 0);
  const missing = await runDahonoCapacityAcceptance({ ...options, ...deps, apiKeyResolver: () => undefined });
  assert.equal(missing.status, 'blocked');
  assert.equal(network, 0);
});

const headerSet = (overrides = {}) => new Headers({
  'content-type': 'text/event-stream', 'x-dahono-slot-id': 'private-slot', 'x-dahono-server-region': 'private-region',
  'x-dahono-concurrency-active': '0', 'x-dahono-concurrency-remaining': '10', 'x-dahono-remaining-rpm': '30',
  'x-dahono-hourly-req-remaining': '600', 'x-dahono-hourly-tokens-input': '0', 'x-dahono-hourly-tokens-output': '0', ...overrides,
});
const sse = (index, invalidUsage = false) => `data: ${JSON.stringify({ id: `req-${index}`, model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'PRIVATE OUTPUT' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: invalidUsage ? 99 : 5 } })}\n\ndata: [DONE]\n\n`;

function fakeProvider({ fast = false, rpm = 30, invalidUsage = false, abortFirst = false, snapshotOverrides = {}, overflowOverrides = {}, chatOverrides = {}, inconsistentAccounting = false, closeBeforeOverflow = false, wrongSlotAt = Infinity } = {}) {
  let clock = Date.parse(START) + 1000;
  let posts = 0;
  let completed = 0;
  let gets = 0;
  let cancelled = 0;
  const held = [];
  const delays = [];
  const fetchImpl = async (url, init) => {
    clock++;
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer TEST-SECRET');
    if (init.method === 'GET') {
      gets++;
      assert.equal(url, 'https://kai.dahono.com/v1/models');
      return new Response('{"data":[]}', { headers: headerSet({
        'content-type': 'application/json', 'x-dahono-hourly-req-remaining': String(600 - completed),
        'x-dahono-hourly-tokens-input': String(completed * 4 + (inconsistentAccounting && gets > 1 ? 1 : 0)),
        'x-dahono-hourly-tokens-output': String(completed), ...snapshotOverrides,
      }) });
    }
    const index = posts++;
    assert.equal(url, 'https://kai.dahono.com/v1/chat/completions');
    assert.equal(JSON.parse(init.body).max_tokens, 512);
    if (index === 10 && !fast) {
      if (closeBeforeOverflow) { held.splice(0).forEach((finish) => finish()); await new Promise((resolve) => setImmediate(resolve)); }
      else setImmediate(() => held.splice(0).forEach((finish) => finish()));
      return new Response('PRIVATE ERROR', { status: 429, headers: headerSet({
        'x-dahono-concurrency-active': '10', 'x-dahono-concurrency-remaining': '0',
        'x-dahono-remaining-rpm': String(Math.max(0, rpm - 11)), 'retry-after': '60', ...overflowOverrides,
      }) });
    }
    if (abortFirst && index === 0) throw Object.assign(new Error('TEST-SECRET'), { name: 'AbortError' });
    const body = new ReadableStream({
      start(controller) {
        const finish = () => { clock++; completed++; controller.enqueue(new TextEncoder().encode(sse(index, invalidUsage))); controller.close(); };
        if (fast || index > 10) finish();
        else held.push(finish);
      },
      cancel() { cancelled++; },
    });
    return new Response(body, { headers: headerSet({
      'x-dahono-slot-id': index >= wrongSlotAt ? 'another-booking' : 'private-slot',
      'x-dahono-concurrency-active': String(index < 10 ? index + 1 : 1),
      'x-dahono-concurrency-remaining': String(index < 10 ? 9 - index : 9),
      'x-dahono-remaining-rpm': String(Math.max(0, rpm - index - 1)),
      ...chatOverrides,
    }) });
  };
  return {
    config: { ...options, apiKeyResolver: () => 'TEST-SECRET', fetchImpl, now: () => clock,
      pause: async (ms) => { delays.push(ms); clock += ms; } }, // Virtual time: no 65-second real wait.
    state: () => ({ posts, gets, cancelled, delays }),
  };
}

test('observes ten unfinished SSE streams before overflow and verifies independent later accounting', async () => {
  const fake = fakeProvider();
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'not_proven');
  for (const [name, claim] of Object.entries(result.claims)) assert.equal(claim.verdict, name === 'concurrencySpecific429' ? 'not_proven' : 'proven');
  assert.equal(result.claims.concurrencySpecific429.reason, 'RATE_LIMIT_CAUSE_UNCONFIRMED');
  assert.equal(result.scope.postRequestsIssued, 14);
  assert.equal(result.scope.getRequestsIssued, 2);
  assert.equal(result.overlap.unfinishedAtOverflow, 10);
  assert.equal(result.accounting.successfulRequests, 13);
  assert.equal(result.accounting.usage.totalUnits, 65);
  assert.deepEqual(fake.state().delays, [65000, 65000, 65000]);
  const evidence = JSON.stringify(result);
  for (const secret of ['TEST-SECRET', 'PRIVATE OUTPUT', 'PRIVATE ERROR', 'private-slot', 'private-region', 'authorization']) assert.equal(evidence.includes(secret), false);
});

test('fast responses skip overflow while allowing three independently spaced accounting samples', async () => {
  const fake = fakeProvider({ fast: true });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'not_proven');
  assert.equal(result.claims.overlapObserved.verdict, 'not_proven');
  assert.equal(result.claims.overload429.verdict, 'not_proven');
  assert.equal(fake.state().posts, 13);
  assert.equal(result.requests.filter((record) => record.phase === 'overflow').length, 0);
  assert.equal(result.requests.filter((record) => record.phase === 'sample').length, 3);
  assert.equal(result.claims.smallSampleAccounting.verdict, 'proven');
});

test('discovery identity drift does not erase ten valid calls or use unrelated quota as the booking gate', async () => {
  const fake = fakeProvider({ fast: true, snapshotOverrides: {
    'x-dahono-slot-id': 'discovery-only-slot',
    'x-dahono-concurrency-active': '10', 'x-dahono-remaining-rpm': '0',
  } });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.claims.bookingSlotBinding.verdict, 'proven');
  assert.equal(result.claims.discoverySlotConsistency.verdict, 'failed');
  assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
  assert.equal(result.status, 'not_proven');
  assert.equal(fake.state().posts, 10); // No usable baseline for paid accounting samples.
});

test('missing or invalid booked identity blocks before resolving credentials or using the network', async () => {
  let credentials = 0;
  let network = 0;
  for (const expectedSlotIdHash of [undefined, '', 'private-untrusted-slot', 'f'.repeat(63)]) {
    const result = await runDahonoCapacityAcceptance({ ...options, expectedSlotIdHash,
      apiKeyResolver: () => { credentials++; return 'secret'; },
      fetchImpl: () => { network++; throw new Error('unexpected'); },
    });
    assert.equal(result.reason, 'BOOKING_IDENTITY_REQUIRED');
    assert.equal(result.status, 'blocked');
  }
  assert.equal(credentials, 0);
  assert.equal(network, 0);
});

test('a chat response for another booking cancels remaining work without issuing accounting samples', async () => {
  const fake = fakeProvider({ wrongSlotAt: 0 });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'failed');
  assert.equal(result.claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(result.requests.some((record) => record.phase === 'sample'), false);
  assert.ok(fake.state().posts <= 10);
  assert.equal(JSON.stringify(result).includes('another-booking'), false);
});

test('a malformed diagnostic counter cannot conceal a wrong booking or allow overflow', async () => {
  const fake = fakeProvider({ wrongSlotAt: 0, chatOverrides: { 'x-dahono-hourly-tokens-input': 'malformed' } });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(result.status, 'failed');
  assert.equal(result.requests.some((record) => record.phase !== 'burst'), false);
  assert.ok(fake.state().posts <= 10);
  assert.ok(result.requests.some((record) => record.slotIdHash && record.diagnostics === null));
  assert.equal(JSON.stringify(result).includes('another-booking'), false);
});

test('unfinished streams with incomplete booking or diagnostics cannot authorize overflow (virtual timer)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const chatOverrides of [{ 'x-dahono-slot-id': '' }, { 'x-dahono-hourly-tokens-input': 'malformed' }]) {
    const fake = fakeProvider({ chatOverrides });
    const pending = runDahonoCapacityAcceptance(fake.config);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_001);
    const result = await pending;
    assert.equal(result.requests.some((record) => record.phase !== 'burst'), false);
    assert.equal(fake.state().posts, 10);
  }
});

test('a later sample changing booking does not erase burst success or allow more samples', async () => {
  const fake = fakeProvider({ wrongSlotAt: 11 });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'failed');
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(result.requests.filter((record) => record.phase === 'sample').length, 1);
  assert.equal(fake.state().posts, 12);
});

test('429 with exhausted RPM proves overload only, not the concurrency-specific limit', async () => {
  const fake = fakeProvider({ rpm: 10 });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.claims.overload429.verdict, 'proven');
  assert.equal(result.claims.concurrencySpecific429.verdict, 'not_proven');
  assert.equal(result.claims.concurrencySpecific429.reason, 'RPM_LIMIT_CONFOUNDED');
  assert.equal(result.status, 'not_proven');
});

test('429 while provider still reports free concurrent capacity cannot prove the concurrency limit', async () => {
  const fake = fakeProvider({ overflowOverrides: { 'x-dahono-concurrency-remaining': '10' } });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.claims.overload429.verdict, 'proven');
  assert.equal(result.claims.concurrencySpecific429.verdict, 'not_proven');
  assert.equal(result.claims.concurrencySpecific429.reason, 'CONCURRENCY_CAPACITY_REMAINS');
});

test('malformed token usage fails ten-stream success and never becomes settled accounting', async () => {
  const fake = fakeProvider({ invalidUsage: true });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'failed');
  assert.equal(result.claims.firstTenSucceeded.verdict, 'failed');
  assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
  assert.equal(result.requests.some((request) => request.errorCode === 'PROVIDER_RESPONSE_INVALID'), true);
});

test('an aborted provider request cancels other open bodies without exposing the original error', async () => {
  const fake = fakeProvider({ abortFirst: true });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.status, 'failed');
  assert.equal(fake.state().cancelled, 9);
  assert.equal(result.requests.some((request) => request.errorCode === 'PROVIDER_TIMEOUT'), true);
  assert.equal(JSON.stringify(result).includes('TEST-SECRET'), false);
});

test('busy slot and insufficient quota stop before any POST', async () => {
  for (const snapshotOverrides of [{ 'x-dahono-concurrency-active': '1' }, { 'x-dahono-hourly-req-remaining': '13' }, { 'x-dahono-remaining-rpm': '9' }]) {
    const fake = fakeProvider({ snapshotOverrides });
    const result = await runDahonoCapacityAcceptance(fake.config);
    assert.equal(result.status, 'blocked');
    assert.equal(fake.state().posts, 0);
    assert.equal(fake.state().gets, 1);
  }
});

test('unexplained final token changes leave accounting unproven when counter units or settlement timing may differ', async () => {
  const fake = fakeProvider({ inconsistentAccounting: true });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
  assert.equal(result.claims.smallSampleAccounting.reason, 'COUNTER_UNIT_OR_SETTLEMENT_MISMATCH');
  assert.equal(result.status, 'not_proven');
});


test('streams finishing before the overflow headers cannot prove concurrent rejection from stale headers', async () => {
  const fake = fakeProvider({ closeBeforeOverflow: true });
  const result = await runDahonoCapacityAcceptance(fake.config);
  assert.equal(result.overlap.unfinishedAtOverflow, 10);
  assert.equal(result.overlap.unfinishedAtOverflowHeaders, 0);
  assert.equal(result.claims.overload429.verdict, 'proven');
  assert.equal(result.claims.concurrencySpecific429.verdict, 'not_proven');
});

test('a hung body reaches the 30-second deadline and every held body is cancelled (virtual timer)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeProvider();
  // Withhold one header so the harness must not issue overflow or rely on it to release bodies.
  const originalFetch = fake.config.fetchImpl;
  let posts = 0;
  fake.config.fetchImpl = (url, init) => {
    if (init.method === 'POST' && ++posts === 10) return new Promise(() => {});
    return originalFetch(url, init);
  };
  const pending = runDahonoCapacityAcceptance(fake.config);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30_001);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.scope.postRequestsIssued, 10);
  assert.equal(fake.state().cancelled, 9);
  assert.equal(result.requests.filter((request) => request.errorCode === 'PROVIDER_TIMEOUT').length, 10);
});

test('preflight validates diagnostics and bounds snapshot body without leaking attacker-controlled errors', async () => {
  for (const response of [
    new Response('{}', { headers: headerSet({ 'x-dahono-hourly-tokens-input': '-1' }) }),
    new Response('x'.repeat(65_537), { headers: headerSet() }),
    new Response('TEST-SECRET', { status: 403, headers: headerSet() }),
  ]) {
    const result = await runDahonoCapacityAcceptance({ ...options, apiKeyResolver: () => 'TEST-SECRET', fetchImpl: async () => response });
    assert.equal(result.status, 'blocked');
    assert.equal(result.scope.postRequestsIssued, 0);
    assert.equal(JSON.stringify(result).includes('TEST-SECRET'), false);
  }
});

test('the five-minute wall deadline aborts a stuck sample pause without issuing more requests (virtual timer)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeProvider();
  let enterPause;
  const paused = new Promise((resolve) => { enterPause = resolve; });
  fake.config.pause = () => { enterPause(); return new Promise(() => {}); };
  const pending = runDahonoCapacityAcceptance(fake.config);
  await paused;
  t.mock.timers.tick(300_001);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'RUN_ABORTED_OR_DEADLINE');
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.scope.postRequestsIssued, 11);
  assert.equal(result.scope.getRequestsIssued, 1);
});
