import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessDahonoCapacityEvidence } from '../src/dahono-capacity-assessment.mjs';

const BOOKING_HASH = '127e1d6485ede53cf1ef15afebea5de395113b3c67deb1a0170c73048712c659';
const DIFFERENT_HASH = 'f'.repeat(64);
const frozen = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
const liveFixture = () => JSON.parse(readFileSync(new URL('../evidence/dahono-capacity/github-37440028834-1-live.json', import.meta.url), 'utf8'));

test('the unchanged 17:00 live record proves ten calls and booking while isolating discovery mismatch', () => {
  const input = frozen(liveFixture());
  const before = JSON.stringify(input);
  const result = assessDahonoCapacityEvidence(input, { expectedSlotIdHash: BOOKING_HASH });
  assert.equal(result.schemaVersion, 'kai-dahono-capacity-assessment.v1');
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.claims.bookingSlotBinding.verdict, 'proven');
  assert.equal(result.claims.discoverySlotConsistency.verdict, 'failed');
  assert.equal(result.observations.peakObservedConcurrentStreams, 7);
  for (const name of ['overlapObserved', 'overload429', 'concurrencySpecific429', 'smallSampleAccounting']) assert.equal(result.claims[name].verdict, 'not_proven');
  assert.equal(result.status, 'not_proven');
  assert.equal(JSON.stringify(input), before);
});

function sampleEvidence({ overflow = false } = {}) {
  const diagnostics = {
    slotIdHash: BOOKING_HASH, serverRegionHash: 'a'.repeat(64), concurrencyActive: 0, concurrencyRemaining: 10,
    remainingRpm: 10, hourlyReqRemaining: 600, hourlyTokensInput: 0, hourlyTokensOutput: 0,
  };
  const request = (index, phase, issuedAt) => ({
    index, phase, issuedAt, headersAt: issuedAt + 1, completedAt: issuedAt + 100, cancelledAt: null,
    sse: true, status: 'succeeded', httpStatus: 200, diagnostics: { ...diagnostics },
    usage: { inputUnits: 4, outputUnits: 1, totalUnits: 5 },
  });
  const requests = Array.from({ length: 10 }, (_, index) => request(index, 'burst', 1000));
  if (overflow) requests.push({ index: 10, phase: 'overflow', issuedAt: 1049, headersAt: 1050, completedAt: null, cancelledAt: 1051,
    sse: false, status: 'failed', httpStatus: 429, diagnostics: { ...diagnostics, concurrencyActive: 10, concurrencyRemaining: 0, remainingRpm: 5 } });
  requests.push(request(11, 'sample', 66_100), request(12, 'sample', 131_200), request(13, 'sample', 196_300));
  return { schemaVersion: 'kai-dahono-capacity-evidence.v2', requests, snapshots: [
    { ...diagnostics, observedAt: 900 },
    { ...diagnostics, observedAt: 196_500, hourlyReqRemaining: 587, hourlyTokensInput: 52, hourlyTokensOutput: 13 },
  ] };
}
const assess = (input) => assessDahonoCapacityEvidence(input, { expectedSlotIdHash: BOOKING_HASH });

test('without overflow, three spaced samples independently prove accounting and are not mistaken for request eleven', () => {
  const result = assess(frozen(sampleEvidence()));
  assert.equal(result.claims.smallSampleAccounting.verdict, 'proven');
  assert.equal(result.claims.overload429.verdict, 'not_proven');
  assert.equal(result.observations.overflowRequests, 0);
  assert.equal(result.observations.sampleRequests, 3);
  assert.equal(result.observations.successfulRequests, 13);
  assert.deepEqual(result.accounting.usage, { inputUnits: 52, outputUnits: 13, totalUnits: 65 });
  assert.deepEqual(result.accounting.observed, { requests: 13, inputUnits: 52, outputUnits: 13 });
  assert.equal(result.claims.overlapObserved.verdict, 'proven');
  assert.equal(result.status, 'not_proven');
});

test('confirmed booking is required and a clearly wrong chat slot is an independent business failure', () => {
  const input = liveFixture();
  const missing = assessDahonoCapacityEvidence(input);
  assert.equal(missing.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(missing.claims.bookingSlotBinding.verdict, 'not_proven');
  assert.equal(missing.status, 'not_proven');
  const wrong = assessDahonoCapacityEvidence(input, { expectedSlotIdHash: DIFFERENT_HASH });
  assert.equal(wrong.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(wrong.claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(wrong.observations.bookingMismatches, 10);
  assert.equal(wrong.status, 'failed');
  delete input.requests[0].diagnostics;
  assert.equal(assess(input).claims.bookingSlotBinding.verdict, 'not_proven');
});

test('duplicate burst identity or malformed usage cannot be repaired by a forged raw passed conclusion', () => {
  for (const change of [
    (input) => { input.requests[1].index = 0; },
    (input) => { input.requests[1].usage.totalUnits = 99; },
    (input) => { input.requests[1].phase = 'invented-phase'; },
    (input) => { input.requests[1].usage.inputUnits = -4; },
    (input) => { input.requests[1].httpStatus = 500; },
  ]) {
    const input = sampleEvidence();
    input.status = 'passed';
    input.claims = { firstTenSucceeded: { verdict: 'proven' }, bookingSlotBinding: { verdict: 'proven' }, smallSampleAccounting: { verdict: 'proven' } };
    change(input);
    const result = assess(input);
    assert.equal(result.claims.firstTenSucceeded.verdict, 'failed');
    assert.equal(result.status, 'failed');
  }
});

test('missing, JSON or invalid stream intervals leave concurrency unproven without negating successful calls', () => {
  for (const change of [
    (input) => { input.requests[0].sse = false; },
    (input) => { delete input.requests[0].sse; },
    (input) => { delete input.requests[0].completedAt; },
    (input) => { input.requests[0].completedAt = input.requests[0].headersAt; },
    (input) => { input.requests[0].cancelledAt = 1020; },
  ]) {
    const input = sampleEvidence();
    change(input);
    const result = assess(input);
    assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
    assert.equal(result.claims.overlapObserved.verdict, 'not_proven');
    assert.equal(result.observations.peakObservedConcurrentStreams, 9);
  }
  const input = liveFixture();
  input.schemaVersion = 'unknown-version';
  assert.equal(assess(input).observations.peakObservedConcurrentStreams, 0);
});

test('observed 429 and full capacity do not manufacture a verified upstream rejection cause', () => {
  const input = sampleEvidence({ overflow: true });
  const output = assess(input);
  assert.equal(output.claims.overload429.verdict, 'proven');
  assert.equal(output.claims.concurrencySpecific429.verdict, 'not_proven');
  assert.equal(output.claims.concurrencySpecific429.reason, 'RATE_LIMIT_CAUSE_UNCONFIRMED');
  assert.equal(output.status, 'not_proven');
  assert.equal(output.claims.smallSampleAccounting.verdict, 'proven');
  input.requests[10].diagnostics.remainingRpm = 0;
  assert.equal(assess(input).claims.concurrencySpecific429.reason, 'RPM_LIMIT_CONFOUNDED');
  input.requests[10].diagnostics.remainingRpm = 5;
  input.requests[10].diagnostics.concurrencyRemaining = 1;
  assert.equal(assess(input).claims.concurrencySpecific429.reason, 'CONCURRENCY_CAPACITY_REMAINS');
  delete input.requests[10].diagnostics;
  assert.equal(assess(input).claims.concurrencySpecific429.reason, 'DIAGNOSTICS_INSUFFICIENT');
});

test('only an identified overflow attempt can prove or fail the overload expectation', () => {
  const input = sampleEvidence({ overflow: true });
  input.requests[10].httpStatus = 200;
  assert.equal(assess(input).claims.overload429.verdict, 'failed');
  input.requests[10].httpStatus = null;
  assert.equal(assess(input).claims.overload429.verdict, 'not_proven');
  input.requests[10].httpStatus = 429;
  input.requests[10].phase = 'sample';
  assert.equal(assess(input).claims.overload429.verdict, 'not_proven');
  input.requests[10].phase = 'overflow';
  input.requests.push({ ...input.requests[10] });
  assert.equal(assess(input).claims.overload429.verdict, 'failed');
});

test('raw status, claims, overlap and accounting are ignored and extra data never reaches the output', () => {
  const input = sampleEvidence();
  const expected = assess(input);
  input.status = 'passed';
  input.claims = { concurrencySpecific429: { verdict: 'proven', reason: 'SECRET' } };
  input.overlap = { unfinishedAtOverflowHeaders: 10, secret: 'SECRET' };
  input.accounting = { usage: { totalUnits: 1234 }, secret: 'SECRET' };
  input.requests[0].usage.authorization = 'SECRET';
  input.requests[0].errorCode = 'SECRET';
  input.source = { secret: 'SECRET' };
  const output = assess(frozen(input));
  assert.deepEqual(output, expected);
  assert.equal(JSON.stringify(output).includes('SECRET'), false);
  assert.equal(JSON.stringify(output).includes(BOOKING_HASH), false);
});

test('sampling requires three unique successes, settled boundaries and real 65-second spacing', () => {
  for (const change of [
    (input) => { input.requests.pop(); },
    (input) => { input.requests[12].index = 12; },
    (input) => { delete input.requests[11].issuedAt; },
    (input) => { input.requests[11].issuedAt = input.requests[10].completedAt + 64_999; },
    (input) => { input.snapshots[0].observedAt = 1002; },
    (input) => { input.snapshots[1].observedAt = 196_399; },
    (input) => { input.snapshots[1].slotIdHash = DIFFERENT_HASH; },
    (input) => { input.snapshots[1].concurrencyActive = 1; },
    (input) => { input.snapshots[1].hourlyTokensInput = -1; },
    (input) => { input.snapshots.pop(); },
  ]) {
    const input = sampleEvidence();
    change(input);
    const result = assess(input);
    assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
    assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
  }
});

test('unknown counter units remain unproven; explicit sample execution failures remain failures', () => {
  const input = sampleEvidence();
  input.snapshots[1].hourlyTokensInput = 51;
  assert.equal(assess(input).claims.smallSampleAccounting.reason, 'COUNTER_UNIT_OR_SETTLEMENT_MISMATCH');
  assert.equal(assess(input).status, 'not_proven');
  input.requests[12].status = 'failed';
  input.requests[12].httpStatus = 500;
  const failed = assess(input);
  assert.equal(failed.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(failed.claims.smallSampleAccounting.verdict, 'failed');
  assert.equal(failed.status, 'failed');
});

test('safe individual token numbers cannot overflow the evidence total', () => {
  const input = sampleEvidence();
  for (const record of input.requests) record.usage = { inputUnits: Number.MAX_SAFE_INTEGER, outputUnits: 0, totalUnits: Number.MAX_SAFE_INTEGER };
  const result = assess(input);
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.accounting.usage, null);
  assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
});

test('empty or malformed evidence does not acquire proof or echo arbitrary values', () => {
  for (const input of [null, {}, { requests: [null, 'SECRET'], snapshots: [null] }]) {
    const result = assessDahonoCapacityEvidence(input, { expectedSlotIdHash: 'SECRET' });
    assert.equal(result.status, 'not_proven');
    assert.equal(result.claims.firstTenSucceeded.verdict, 'not_proven');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
});

test('contradictory overflow timing cannot strengthen an otherwise matching accounting sample', () => {
  const input = sampleEvidence({ overflow: true });
  input.requests[10].issuedAt = 200_000;
  const result = assess(input);
  assert.equal(result.claims.smallSampleAccounting.verdict, 'not_proven');
});

test('impossible or incomplete issue times cannot prove v2 overlapping SSE streams', () => {
  for (const invalidIssuedAt of [5000, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const input = sampleEvidence();
    for (const record of input.requests.slice(0, 10)) {
      record.issuedAt = invalidIssuedAt;
      record.headersAt = 1000;
      record.completedAt = 2000;
    }
    input.claims = { overlapObserved: { verdict: 'proven' } };
    input.overlap = { unfinishedAtOverflow: 10 };
    const result = assess(input);
    assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
    assert.equal(result.claims.overlapObserved.verdict, 'not_proven');
    assert.equal(result.observations.peakObservedConcurrentStreams, 0);
  }
});

test('legacy intervals accept absent issue times but validate supplied times and burst phase', () => {
  const input = liveFixture();
  assert.equal(assess(input).observations.peakObservedConcurrentStreams, 7);
  for (const record of input.requests) record.issuedAt = record.headersAt + 1;
  assert.equal(assess(input).observations.peakObservedConcurrentStreams, 0);
  for (const record of input.requests) {
    record.issuedAt = record.headersAt;
    record.phase = 'sample';
  }
  assert.equal(assess(input).observations.peakObservedConcurrentStreams, 0);
});

test('independent chat identity preserves a wrong booking even when diagnostic counters are invalid', () => {
  const input = sampleEvidence();
  input.requests[0].slotIdHash = DIFFERENT_HASH;
  input.requests[0].diagnostics = null;
  const result = assess(input);
  assert.equal(result.claims.firstTenSucceeded.verdict, 'proven');
  assert.equal(result.claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(result.observations.bookingMismatches, 1);
  assert.equal(result.status, 'failed');
});

test('top-level booking identity works independently and conflicting identities cannot silently take priority', () => {
  const input = sampleEvidence();
  for (const record of input.requests) {
    record.slotIdHash = BOOKING_HASH;
    record.diagnostics = null;
  }
  assert.equal(assess(input).claims.bookingSlotBinding.verdict, 'proven');
  assert.equal(assess(input).claims.discoverySlotConsistency.verdict, 'proven');
  input.requests[0].diagnostics = { slotIdHash: DIFFERENT_HASH };
  assert.equal(assess(input).claims.bookingSlotBinding.verdict, 'failed');
  input.requests[0].slotIdHash = DIFFERENT_HASH;
  input.requests[0].diagnostics.slotIdHash = BOOKING_HASH;
  assert.equal(assess(input).claims.bookingSlotBinding.verdict, 'failed');
  assert.equal(JSON.stringify(assess(input)).includes(BOOKING_HASH), false);
});
