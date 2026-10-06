import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DahonoRouterProviderAdapter, DAHONO_ROUTER_MODEL } from './adapters/dahono-router-provider.mjs';
import { assessDahonoCapacityEvidence } from './dahono-capacity-assessment.mjs';

const MODELS_ENDPOINT = 'https://kai.dahono.com/v1/models';
const MAX_POSTS = 14;
const MAX_DURATION_MS = 300_000;
const SAFE_ERRORS = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_RATE_LIMITED', 'PROVIDER_WINDOW_CLOSED', 'PROVIDER_CREDENTIAL_INVALID', 'PROVIDER_HTTP_ERROR', 'PROVIDER_UNAVAILABLE']);
const NUMERIC_HEADERS = {
  concurrencyActive: 'x-dahono-concurrency-active', concurrencyRemaining: 'x-dahono-concurrency-remaining',
  remainingRpm: 'x-dahono-remaining-rpm', hourlyReqRemaining: 'x-dahono-hourly-req-remaining',
  hourlyTokensInput: 'x-dahono-hourly-tokens-input', hourlyTokensOutput: 'x-dahono-hourly-tokens-output',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const guarded = (operation, signal) => {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};
const bookingIdentity = (headers) => {
  const slot = headers?.get('x-dahono-slot-id');
  return slot && slot.length <= 1024 ? hash(slot) : null;
};
const diagnostics = (headers) => {
  const slotIdHash = bookingIdentity(headers);
  const region = headers?.get('x-dahono-server-region');
  if (!slotIdHash || !region || region.length > 1024) return null;
  const result = { slotIdHash, serverRegionHash: hash(region) };
  for (const [name, header] of Object.entries(NUMERIC_HEADERS)) {
    const raw = headers.get(header);
    if (!raw || !/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) return null;
    result[name] = Number(raw);
  }
  return result;
};
const validWindow = (start, end, time) => {
  const explicitZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof start !== 'string' || typeof end !== 'string' || !explicitZone.test(start) || !explicitZone.test(end)) return false;
  const calendarValid = (value) => {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  return calendarValid(start) && calendarValid(end) && Date.parse(end) - Date.parse(start) === 3_600_000
    && time >= Date.parse(start) && Date.parse(end) - time >= MAX_DURATION_MS;
};
const cancel = (body) => { try { body?.cancel?.()?.catch?.(() => {}); } catch { /* already closed */ } };

/** Bounded live acceptance. Clock, pause and HTTP are injected only for independent boundary tests. */
export async function runDahonoCapacityAcceptance({
  confirmLive = false, windowStart, windowEnd, expectedSlotIdHash, apiKeyResolver, fetchImpl = globalThis.fetch,
  now = () => Date.now(), pause = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
  const evidence = {
    schemaVersion: 'kai-dahono-capacity-evidence.v2', status: 'blocked', reason: 'LIVE_CONFIRMATION_REQUIRED',
    scope: { networkAttempted: false, networkUsed: false, credentialsUsed: false, credentialResolved: false, postRequestsIssued: 0, getRequestsIssued: 0, maxPostRequests: MAX_POSTS, maxDurationMs: MAX_DURATION_MS, fullHourlyQuotaProven: false },
    claims: assessDahonoCapacityEvidence({ requests: [], snapshots: [] }).claims,
    requests: [], snapshots: [], overlap: { unfinishedAtOverflow: 0 },
  };
  if (confirmLive !== true) return evidence;
  if (!validWindow(windowStart, windowEnd, now())) { evidence.reason = 'WINDOW_INVALID_OR_TOO_SHORT'; return evidence; }
  if (typeof expectedSlotIdHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSlotIdHash)) { evidence.reason = 'BOOKING_IDENTITY_REQUIRED'; return evidence; }
  evidence.expectedSlotIdHash = expectedSlotIdHash;
  const started = now();
  let key;
  try { key = await guarded(Promise.resolve().then(() => apiKeyResolver?.()), AbortSignal.timeout(10_000)); } catch { evidence.reason = 'CREDENTIAL_UNAVAILABLE'; return evidence; }
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) { evidence.reason = 'CREDENTIAL_REQUIRED'; return evidence; }
  key = key.trim();
  evidence.scope.credentialResolved = true;
  if (!validWindow(windowStart, windowEnd, now())) { evidence.reason = 'WINDOW_INVALID_OR_TOO_SHORT'; return evidence; }
  evidence.startedAt = new Date(started).toISOString();
  const whole = new AbortController();
  const timer = setTimeout(() => whole.abort(), Math.max(1, MAX_DURATION_MS - (now() - started)));
  const activeBodies = new Set();
  const pending = [];
  const records = [];
  const ensureActive = () => {
    if (whole.signal.aborted || now() >= Date.parse(windowEnd) || now() - started >= MAX_DURATION_MS) throw abortError();
  };
  const network = async (url, init) => {
    ensureActive();
    evidence.scope.networkAttempted = true;
    evidence.scope.networkUsed = true;
    evidence.scope.credentialsUsed = true;
    const promise = Promise.resolve().then(() => fetchImpl(url, init));
    promise.then((response) => { if (init.signal.aborted) cancel(response?.body); }, () => {});
    return guarded(promise, init.signal);
  };
  const snapshot = async () => {
    if (evidence.scope.getRequestsIssued >= 2) throw new Error('SNAPSHOT_LIMIT');
    evidence.scope.getRequestsIssued++;
    const timeout = AbortSignal.timeout(10_000);
    const signal = AbortSignal.any([whole.signal, timeout]);
    const response = await network(MODELS_ENDPOINT, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal });
    const safe = diagnostics(response.headers);
    let reader;
    try {
      if (response.status !== 200 || !safe || !response.body?.getReader) throw new Error('SNAPSHOT_INVALID');
      reader = response.body.getReader();
      let bytes = 0;
      while (true) {
        const item = await guarded(reader.read(), signal);
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 65_536) throw new Error('SNAPSHOT_TOO_LARGE');
      }
    } finally {
      if (reader) { try { reader.cancel()?.catch?.(() => {}); } catch { /* already closed */ } reader.releaseLock(); }
      else cancel(response.body);
    }
    const result = { observedAt: now(), ...safe };
    evidence.snapshots.push(result);
    return result;
  };
  const issue = (index, phase) => {
    const record = { index, phase, issuedAt: now(), status: 'pending', headersAt: null, completedAt: null, cancelledAt: null, httpStatus: null, diagnostics: null };
    records.push(record);
    let headersResolve;
    record.headersReady = new Promise((resolve) => { headersResolve = resolve; });
    const adapter = new DahonoRouterProviderAdapter({
      apiKeyResolver: () => key, networkMode: 'live', timeoutMs: 30_000,
      fetchImpl: async (url, init) => {
        ensureActive();
        if (evidence.scope.postRequestsIssued >= MAX_POSTS) throw new Error('POST_LIMIT');
        evidence.scope.postRequestsIssued++;
        const signal = AbortSignal.any([init.signal, whole.signal]);
        const response = await network(url, { ...init, signal });
        if (index === 10) evidence.overlap.unfinishedAtOverflowHeaders = records.slice(0, 10).filter((item) => item.completedAt === null && item.cancelledAt === null && item.status === 'pending').length;
        record.httpStatus = response.status;
        record.headersAt = now();
        record.slotIdHash = bookingIdentity(response.headers);
        record.diagnostics = diagnostics(response.headers);
        record.sse = /(?:^|;)\s*text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '');
        if (record.slotIdHash && record.slotIdHash !== expectedSlotIdHash) whole.abort();
        const retry = response.headers.get('retry-after');
        if (retry && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry))) record.retryAfterSeconds = Number(retry);
        if (!response.body?.getReader) { headersResolve(); return response; }
        const reader = response.body.getReader();
        const cleanup = () => {
          record.cancelledAt ??= now();
          activeBodies.delete(cleanup);
          signal.removeEventListener('abort', cleanup);
          try { reader.cancel()?.catch?.(() => {}); } catch { /* already closed */ }
        };
        activeBodies.add(cleanup);
        signal.addEventListener('abort', cleanup, { once: true });
        if (signal.aborted) cleanup();
        headersResolve();
        return {
          status: response.status, ok: response.ok, headers: response.headers,
          body: { getReader: () => ({
            read: async () => {
              const item = await guarded(reader.read(), signal);
              if (item.done) {
                record.completedAt = now();
                activeBodies.delete(cleanup);
                signal.removeEventListener('abort', cleanup);
              }
              return item;
            },
            cancel: cleanup,
            releaseLock: () => { try { reader.releaseLock(); } catch { /* pending read may retain the lock until abort settles */ } },
          }) },
        };
      },
    });
    const promise = adapter.execute({
      requestId: `capacity-${index}`, idempotencyKey: `capacity-test-${index}`, model: DAHONO_ROUTER_MODEL, region: 'provider-default',
      input: { prompt: 'List the integers from 1 to 250, one integer per line. Do not omit any.', max_tokens: 512, temperature: 0 },
    }).then((result) => {
      record.status = 'succeeded';
      record.usage = { inputUnits: result.usage.inputUnits, outputUnits: result.usage.outputUnits, totalUnits: result.usage.totalUnits };
    }, (error) => {
      record.status = 'failed';
      record.errorCode = SAFE_ERRORS.has(error?.code) ? error.code : 'PROVIDER_ERROR';
      if (index < 10) whole.abort();
    }).finally(() => headersResolve());
    record.done = promise;
    pending.push(promise);
    return record;
  };
  try {
    const before = await snapshot();
    if (before.slotIdHash === expectedSlotIdHash && (before.concurrencyActive !== 0 || before.concurrencyRemaining < 10 || before.remainingRpm < 10 || before.hourlyReqRemaining < MAX_POSTS)) {
      evidence.reason = 'SLOT_NOT_IDLE_OR_QUOTA_INSUFFICIENT';
      return evidence;
    }
    evidence.status = 'not_proven';
    const first = Array.from({ length: 10 }, (_, index) => issue(index, 'burst'));
    await Promise.all(first.map((record) => record.headersReady));
    // Let already buffered responses finish naturally; never pause body consumption to fake concurrency.
    await new Promise((resolve) => setImmediate(resolve));
    const unfinished = first.filter((record) => record.httpStatus === 200 && record.sse && record.completedAt === null && record.cancelledAt === null && record.status === 'pending');
    evidence.overlap.unfinishedAtOverflow = unfinished.length;
    if (unfinished.length === 10 && unfinished.every((record) => record.slotIdHash === expectedSlotIdHash && record.diagnostics) && !whole.signal.aborted) {
      const overflow = issue(10, 'overflow');
      await overflow.done;
    }
    await Promise.all(pending);
    const burstAssessment = assessDahonoCapacityEvidence({ ...evidence, requests: records }, { expectedSlotIdHash });
    // Accounting needs a baseline for this booking, not an overflow rejection.
    if (burstAssessment.claims.firstTenSucceeded.verdict === 'proven'
      && burstAssessment.claims.bookingSlotBinding.verdict === 'proven'
      && before.slotIdHash === expectedSlotIdHash && !whole.signal.aborted) {
      for (let index = 11; index < MAX_POSTS; index++) {
        ensureActive();
        await guarded(pause(65_000, whole.signal), whole.signal);
        ensureActive();
        const sample = issue(index, 'sample');
        await sample.done;
        if (sample.status !== 'succeeded' || whole.signal.aborted) break;
      }
      await snapshot();
    }
    evidence.reason = 'LIMITED_CLAIMS_ONLY';
  } catch {
    evidence.status = evidence.scope.postRequestsIssued ? 'failed' : 'blocked';
    evidence.reason = whole.signal.aborted ? 'RUN_ABORTED_OR_DEADLINE' : 'SNAPSHOT_OR_WINDOW_INVALID';
  } finally {
    whole.abort();
    for (const cleanup of activeBodies) cleanup();
    await Promise.all(pending);
    clearTimeout(timer);
    evidence.finishedAt = new Date(now()).toISOString();
    evidence.requests = records.map(({ index, phase, issuedAt, sse, slotIdHash, status, headersAt, completedAt, cancelledAt, httpStatus, diagnostics: safe, retryAfterSeconds, usage, errorCode }) => ({ index, phase, issuedAt, sse: sse === true, slotIdHash: slotIdHash ?? null, status, headersAt, completedAt, cancelledAt, httpStatus, diagnostics: safe, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), ...(usage ? { usage } : {}), ...(errorCode ? { errorCode } : {}) }));
    const assessment = assessDahonoCapacityEvidence(evidence, { expectedSlotIdHash });
    evidence.claims = assessment.claims;
    evidence.observations = assessment.observations;
    if (assessment.accounting) evidence.accounting = assessment.accounting;
    if (evidence.status !== 'blocked' && evidence.status !== 'failed') evidence.status = assessment.status;
  }
  return evidence;
}
