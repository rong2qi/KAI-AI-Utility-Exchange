const isUsage = (usage) => usage
  && Number.isSafeInteger(usage.inputUnits)
  && Number.isSafeInteger(usage.outputUnits)
  && Number.isSafeInteger(usage.totalUnits)
  && usage.inputUnits >= 0
  && usage.outputUnits >= 0
  && usage.totalUnits === usage.inputUnits + usage.outputUnits;

const emptyUsage = () => ({ inputUnits: 0, outputUnits: 0, totalUnits: 0 });
const SAFE_CODES = new Set(['PROVIDER_RATE_LIMITED', 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'REQUEST_INVALID']);

const addUsage = (total, usage) => ({
  inputUnits: total.inputUnits + usage.inputUnits,
  outputUnits: total.outputUnits + usage.outputUnits,
  totalUnits: total.totalUnits + usage.totalUnits,
});

const settle = async (index, promise) => {
  try {
    return { index, ok: true, result: await promise };
  } catch (error) {
    return { index, ok: false, error: { code: SAFE_CODES.has(error?.code) ? error.code : 'UNKNOWN', retryable: error?.retryable === true } };
  }
};

/**
 * Evaluates a bounded burst through ProviderAdapterPort. Transport safety and
 * accepted-stream telemetry belong to the caller, not this result evaluator.
 */
export async function runConcurrencyQuotaAcceptance({
  adapter,
  buildRequest,
  concurrencyLimit = 10,
} = {}) {
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('ACCEPTANCE_ADAPTER_REQUIRED');
  if (typeof buildRequest !== 'function') throw new Error('ACCEPTANCE_REQUEST_BUILDER_REQUIRED');
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 32) throw new Error('ACCEPTANCE_CONCURRENCY_INVALID');

  const startedAt = new Date().toISOString();
  const outcomes = await Promise.all(
    Array.from({ length: concurrencyLimit + 1 }, (_, index) => settle(index,
      Promise.resolve().then(() => adapter.execute(buildRequest(index))),
    )),
  );
  const successful = outcomes.filter((outcome) => outcome.ok && outcome.result?.status === 'succeeded');
  const rateLimited = outcomes.filter((outcome) => !outcome.ok && outcome.error.code === 'PROVIDER_RATE_LIMITED' && outcome.error.retryable);
  const successfulRequestIndexes = successful.map((outcome) => outcome.index).sort((a, b) => a - b);
  const rateLimitedRequestIndexes = rateLimited.map((outcome) => outcome.index);
  const invalidSuccesses = successful.filter((outcome) => !isUsage(outcome.result.usage));
  const sum = successful.filter((outcome) => isUsage(outcome.result.usage)).reduce(
    (total, outcome) => addUsage(total, outcome.result.usage),
    emptyUsage(),
  );
  const usage = isUsage(sum) ? sum : null;
  const checks = {
    successfulRequests: successfulRequestIndexes.length === concurrencyLimit
      && successfulRequestIndexes.every((index, expected) => index === expected),
    rateLimitedRequests: rateLimited.length === 1 && rateLimitedRequestIndexes[0] === concurrencyLimit,
    usageTotals: invalidSuccesses.length === 0 && usage !== null,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);

  return {
    schemaVersion: 'kai-provider-concurrency-quota-evidence.v2',
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    level: 'provider-burst-results',
    startedAt,
    scope: {
      concurrencyLimit,
      requestsIssued: outcomes.length,
    },
    claim: '前 N 个请求成功且用量合法，第 N+1 个请求返回可重试限流',
    doesNotProve: ['accepted_stream_overlap', 'rate_limit_cause', 'hourly_quota', 'transport_isolation'],
    checks,
    failedChecks,
    results: {
      successfulRequests: successful.length,
      successfulRequestIndexes,
      rateLimitedRequests: rateLimited.length,
      rateLimitedRequestIndexes,
      usage,
      errors: outcomes.filter((outcome) => !outcome.ok).map((outcome) => ({ index: outcome.index, ...outcome.error })),
    },
  };
}
