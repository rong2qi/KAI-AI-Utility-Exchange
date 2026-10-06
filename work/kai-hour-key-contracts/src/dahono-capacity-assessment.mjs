const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const slotHash = (value) => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : null;
const chatIdentity = (record) => {
  const direct = slotHash(record.slotIdHash);
  const diagnostic = slotHash(record.diagnostics?.slotIdHash);
  const values = [...new Set([direct, diagnostic].filter(Boolean))];
  const malformedDirect = Object.hasOwn(record, 'slotIdHash') && direct === null;
  return { values, complete: values.length === 1 && !malformedDirect, conflict: values.length > 1 };
};
const claim = (verdict = 'not_proven', reason = 'NOT_RUN') => ({ verdict, reason });
const usageValid = (usage) => object(usage)
  && integer(usage.inputUnits) && integer(usage.outputUnits) && integer(usage.totalUnits)
  && Number.isSafeInteger(usage.inputUnits + usage.outputUnits)
  && usage.totalUnits === usage.inputUnits + usage.outputUnits;
const succeeded = (record) => record?.httpStatus === 200 && record?.status === 'succeeded' && usageValid(record.usage);
const LEGACY_SCHEMAS = new Set(['kai-dahono-capacity-run.v1', 'kai-dahono-capacity-evidence.v1']);
const PHASES = new Set(['burst', 'overflow', 'sample']);
const phaseOf = (record, legacy) => {
  if (record.phase !== undefined) return PHASES.has(record.phase) ? record.phase : null;
  if (!legacy || !integer(record.index)) return null;
  return record.index < 10 ? 'burst' : record.index === 10 ? 'overflow' : record.index < 14 ? 'sample' : null;
};
const interval = (record, legacy) => {
  if (phaseOf(record, legacy) !== 'burst') return null;
  if (!succeeded(record) || (record.sse !== true && !(legacy && record.sse === undefined))) return null;
  if (!integer(record.headersAt) || !integer(record.completedAt) || record.completedAt <= record.headersAt) return null;
  if ((!legacy || Object.hasOwn(record, 'issuedAt')) && (!integer(record.issuedAt) || record.issuedAt > record.headersAt)) return null;
  if (record.cancelledAt !== null && record.cancelledAt !== undefined) return null;
  return { start: record.headersAt, end: record.completedAt };
};
const peak = (intervals) => {
  const events = intervals.flatMap((value) => [[value.start, 1], [value.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let maximum = 0;
  for (const [, difference] of events) { active += difference; maximum = Math.max(maximum, active); }
  return maximum;
};
const safeUsageSum = (records) => {
  const usage = { inputUnits: 0, outputUnits: 0, totalUnits: 0 };
  for (const record of records) {
    if (!usageValid(record.usage)) return null;
    for (const name of Object.keys(usage)) {
      usage[name] += record.usage[name];
      if (!integer(usage[name])) return null;
    }
  }
  return usage;
};
const validSnapshot = (snapshot) => object(snapshot) && slotHash(snapshot.slotIdHash) && integer(snapshot.observedAt)
  && ['concurrencyActive', 'concurrencyRemaining', 'remainingRpm', 'hourlyReqRemaining', 'hourlyTokensInput', 'hourlyTokensOutput'].every((name) => integer(snapshot[name]));

/** Pure assessment: raw conclusions, messages and extra fields never become assessment evidence. */
export function assessDahonoCapacityEvidence(evidence, { expectedSlotIdHash } = {}) {
  const source = object(evidence) ? evidence : {};
  const requests = Array.isArray(source.requests) ? source.requests : [];
  const snapshots = Array.isArray(source.snapshots) ? source.snapshots : [];
  const records = requests.filter(object);
  const legacy = LEGACY_SCHEMAS.has(source.schemaVersion);
  const expected = slotHash(expectedSlotIdHash);
  const first = records.filter((record) => integer(record.index) && record.index < 10);
  const samples = records.filter((record) => phaseOf(record, legacy) === 'sample');
  const overflows = records.filter((record) => phaseOf(record, legacy) === 'overflow');
  const firstIdentitiesValid = first.length === 10 && new Set(first.map((record) => record.index)).size === 10;
  const firstInvalid = first.some((record) => phaseOf(record, legacy) !== 'burst' || !succeeded(record))
    || new Set(first.map((record) => record.index)).size !== first.length;
  const claims = {
    firstTenSucceeded: firstInvalid ? claim('failed', 'BURST_RESPONSE_OR_IDENTITY_INVALID')
      : firstIdentitiesValid ? claim('proven', 'TEN_VALID_RESPONSES') : claim('not_proven', 'TEN_REQUESTS_INCOMPLETE'),
    bookingSlotBinding: claim(), discoverySlotConsistency: claim(), overlapObserved: claim(), overload429: claim(), concurrencySpecific429: claim(), smallSampleAccounting: claim(),
  };
  const identities = records.map(chatIdentity);
  const knownChatHashes = new Set(identities.flatMap((identity) => identity.values));
  const bookingMismatches = expected ? identities.filter((identity) => identity.values.some((hash) => hash !== expected)).length : 0;
  const identityConflicts = identities.filter((identity) => identity.conflict).length;
  claims.bookingSlotBinding = identityConflicts ? claim('failed', 'CHAT_SLOT_IDENTITY_CONFLICT')
    : !expected ? claim('not_proven', 'EXPECTED_BOOKING_REQUIRED')
      : bookingMismatches ? claim('failed', 'CHAT_BOOKING_MISMATCH')
      : !records.length || records.length !== requests.length || identities.some((identity) => !identity.complete) ? claim('not_proven', 'CHAT_SLOT_INCOMPLETE')
        : claim('proven', 'CHAT_MATCHES_CONFIRMED_BOOKING');

  const discoveryHashes = snapshots.map((snapshot) => slotHash(snapshot?.slotIdHash));
  const discoveryMismatch = knownChatHashes.size > 1
    || discoveryHashes.some((hash) => hash && knownChatHashes.size > 0 && !knownChatHashes.has(hash));
  claims.discoverySlotConsistency = discoveryMismatch ? claim('failed', 'DISCOVERY_CHAT_SLOT_MISMATCH')
    : snapshots.length === 2 && records.length > 0 && identities.every((identity) => identity.complete) && discoveryHashes.every(Boolean) ? claim('proven', 'DISCOVERY_CHAT_SLOTS_MATCH')
      : claim('not_proven', 'DISCOVERY_OR_CHAT_SLOT_INCOMPLETE');

  const intervals = firstIdentitiesValid ? first.map((record) => interval(record, legacy)).filter(Boolean) : [];
  const observedPeak = peak(intervals);
  claims.overlapObserved = observedPeak === 10 ? claim('proven', 'TEN_UNFINISHED_SSE_STREAMS')
    : claim('not_proven', 'TEN_STREAM_OVERLAP_NOT_OBSERVED');
  const overflow = overflows.length === 1 && overflows[0].index === 10 ? overflows[0] : null;
  if (overflows.length > 1 || (overflows.length === 1 && !overflow)) {
    claims.overload429 = claim('failed', 'OVERFLOW_IDENTITY_INVALID');
  } else if (overflow) {
    claims.overload429 = overflow.httpStatus === 429 ? claim('proven', 'HTTP_429_OBSERVED')
      : integer(overflow.httpStatus) ? claim('failed', 'EXPECTED_429_NOT_OBSERVED')
        : claim('not_proven', 'OVERFLOW_RESPONSE_INCOMPLETE');
  }
  const concurrentAtHeaders = overflow && integer(overflow.headersAt)
    ? intervals.filter((value) => value.start <= overflow.headersAt && value.end > overflow.headersAt).length : 0;
  if (overflow?.httpStatus === 429) {
    const diagnostics = overflow.diagnostics;
    const atLimit = concurrentAtHeaders === 10 && claims.bookingSlotBinding.verdict === 'proven'
      && diagnostics?.concurrencyActive === 10 && diagnostics?.concurrencyRemaining === 0;
    claims.concurrencySpecific429 = claim('not_proven', diagnostics?.remainingRpm === 0 ? 'RPM_LIMIT_CONFOUNDED'
      : integer(diagnostics?.concurrencyRemaining) && diagnostics.concurrencyRemaining > 0 ? 'CONCURRENCY_CAPACITY_REMAINS'
        : atLimit && integer(diagnostics?.remainingRpm) && diagnostics.remainingRpm > 0 ? 'RATE_LIMIT_CAUSE_UNCONFIRMED'
          : 'DIAGNOSTICS_INSUFFICIENT');
  }
  const successful = records.filter(succeeded);
  const sampleFailed = samples.some((record) => record.status === 'failed' || (record.status === 'succeeded' && !succeeded(record)));
  let accounting;
  if (sampleFailed) {
    claims.smallSampleAccounting = claim('failed', 'SAMPLE_REQUEST_FAILED');
  } else if (samples.length > 0) {
    const ordered = [...samples].sort((a, b) => a.index - b.index);
    const samplesComplete = samples.length === 3 && ordered.every((record, index) => record.index === 11 + index && succeeded(record));
    const before = snapshots[0];
    const after = snapshots[1];
    const snapshotsComplete = snapshots.length === 2 && validSnapshot(before) && validSnapshot(after);
    const usage = safeUsageSum(successful);
    const recordTimesValid = successful.every((record) => integer(record.issuedAt) && integer(record.headersAt) && integer(record.completedAt)
      && record.issuedAt <= record.headersAt && record.headersAt <= record.completedAt);
    const burstEnd = first.length ? Math.max(...first.map((record) => integer(record.completedAt) ? record.completedAt : Infinity)) : Infinity;
    const overflowEnd = overflow ? [overflow.completedAt, overflow.cancelledAt, overflow.headersAt].find(integer) : 0;
    const overflowTimesValid = !overflow || (integer(overflow.issuedAt) && integer(overflow.headersAt)
      && overflow.issuedAt <= overflow.headersAt && integer(overflowEnd) && overflowEnd >= overflow.headersAt);
    let previousEnd = Math.max(burstEnd, overflowEnd ?? Infinity);
    const sampleSpacingValid = samplesComplete && ordered.every((record) => {
      const valid = integer(record.issuedAt) && record.issuedAt - previousEnd >= 65_000;
      previousEnd = record.completedAt;
      return valid;
    });
    const observed = snapshotsComplete ? {
      requests: before.hourlyReqRemaining - after.hourlyReqRemaining,
      inputUnits: after.hourlyTokensInput - before.hourlyTokensInput,
      outputUnits: after.hourlyTokensOutput - before.hourlyTokensOutput,
    } : null;
    accounting = { successfulRequests: successful.length, sampleRequests: samples.length, usage, observed };
    const comparable = claims.firstTenSucceeded.verdict === 'proven' && claims.bookingSlotBinding.verdict === 'proven'
      && samplesComplete && successful.length === 13 && records.length === 13 + overflows.length && snapshotsComplete
      && slotHash(before.slotIdHash) === expected && slotHash(after.slotIdHash) === expected
      && before.concurrencyActive === 0 && after.concurrencyActive === 0 && recordTimesValid && overflowTimesValid && sampleSpacingValid && usage
      && before.observedAt <= Math.min(...successful.map((record) => record.issuedAt))
      && after.observedAt >= Math.max(...successful.map((record) => record.completedAt));
    const exact = comparable && observed.requests === 13 && observed.inputUnits === usage.inputUnits && observed.outputUnits === usage.outputUnits;
    claims.smallSampleAccounting = exact ? claim('proven', 'INDEPENDENT_COUNTERS_MATCH')
      : comparable ? claim('not_proven', 'COUNTER_UNIT_OR_SETTLEMENT_MISMATCH') : claim('not_proven', 'SAMPLE_OR_SLOT_INCOMPLETE');
  }
  const executionFailed = claims.firstTenSucceeded.verdict === 'failed' || sampleFailed;
  const status = executionFailed || claims.bookingSlotBinding.verdict === 'failed' || claims.overload429.verdict === 'failed' ? 'failed'
    : Object.values(claims).every((value) => value.verdict === 'proven') ? 'passed' : 'not_proven';
  return {
    schemaVersion: 'kai-dahono-capacity-assessment.v1', status, claims,
    observations: {
      requestCount: requests.length, successfulRequests: successful.length, firstTenSuccessfulRequests: first.filter(succeeded).length,
      peakObservedConcurrentStreams: observedPeak, overflowRequests: overflows.length, sampleRequests: samples.length,
      bookingMismatches, slotIdentityConflicts: identityConflicts, uniqueChatSlotCount: knownChatHashes.size, discoverySnapshots: snapshots.length,
      unfinishedAtOverflowHeaders: concurrentAtHeaders,
    },
    ...(accounting ? { accounting } : {}),
  };
}
