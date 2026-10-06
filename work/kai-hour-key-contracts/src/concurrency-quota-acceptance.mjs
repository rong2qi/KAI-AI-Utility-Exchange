const isUsage = (usage) => usage
  && Number.isSafeInteger(usage.inputUnits)
  && Number.isSafeInteger(usage.outputUnits)
  && Number.isSafeInteger(usage.totalUnits)
  && usage.inputUnits >= 0
  && usage.outputUnits >= 0
  && usage.totalUnits === usage.inputUnits + usage.outputUnits;

const emptyUsage = () => ({ inputUnits: 0, outputUnits: 0, totalUnits: 0 });

const addUsage = (total, usage) => ({
  inputUnits: total.inputUnits + usage.inputUnits,
  outputUnits: total.outputUnits + usage.outputUnits,
  totalUnits: total.totalUnits + usage.totalUnits,
});

const settle = async (index, promise) => {
  try {
    return { index, ok: true, result: await promise };
  } catch (error) {
    return { index, ok: false, error: { code: error?.code || 'UNKNOWN', retryable: error?.retryable === true } };
  }
};

/**
 * Runs a deterministic burst through any ProviderAdapterPort implementation.
 * The adapter is the only seam; this function never opens a network connection.
 */
export async function runConcurrencyQuotaAcceptance({
  adapter,
  buildRequest,
  concurrencyLimit = 10,
  rateLimitCode = 'PROVIDER_RATE_LIMITED',
} = {}) {
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('ACCEPTANCE_ADAPTER_REQUIRED');
  if (typeof buildRequest !== 'function') throw new Error('ACCEPTANCE_REQUEST_BUILDER_REQUIRED');
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) throw new Error('ACCEPTANCE_CONCURRENCY_INVALID');

  const startedAt = new Date().toISOString();
  const outcomes = await Promise.all(
    Array.from({ length: concurrencyLimit + 1 }, (_, index) => settle(index,
      Promise.resolve().then(() => adapter.execute(buildRequest(index))),
    )),
  );
  const successful = outcomes.filter((outcome) => outcome.ok && outcome.result?.status === 'succeeded');
  const rateLimited = outcomes.filter((outcome) => !outcome.ok && outcome.error.code === rateLimitCode);
  const successfulRequestIndexes = successful.map((outcome) => outcome.index).sort((a, b) => a - b);
  const rateLimitedRequestIndexes = rateLimited.map((outcome) => outcome.index);
  const invalidSuccesses = successful.filter((outcome) => !isUsage(outcome.result.usage));
  const usage = successful.reduce(
    (total, outcome) => addUsage(total, outcome.result.usage),
    emptyUsage(),
  );
  const checks = {
    successfulRequests: successfulRequestIndexes.length === concurrencyLimit
      && successfulRequestIndexes.every((index, expected) => index === expected),
    rateLimitedRequests: rateLimited.length === 1 && rateLimitedRequestIndexes[0] === concurrencyLimit,
    usageTotals: invalidSuccesses.length === 0 && usage.totalUnits === usage.inputUnits + usage.outputUnits,
    peakConcurrency: adapter.peakConcurrency === concurrencyLimit,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);

  return {
    schemaVersion: 'kai-provider-concurrency-quota-evidence.v1',
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    level: 'local-provider-concurrency-quota',
    startedAt,
    scope: {
      networkDisabled: true,
      credentialsUsed: false,
      concurrencyLimit,
      requestsIssued: outcomes.length,
    },
    claim: '本地可替换 Provider 在并发上限内完成请求，并对第 N+1 路返回可重试限流，同时汇总 token 用量',
    checks,
    failedChecks,
    results: {
      successfulRequests: successful.length,
      successfulRequestIndexes,
      rateLimitedRequests: rateLimited.length,
      rateLimitedRequestIndexes,
      usage,
      peakConcurrency: adapter.peakConcurrency ?? null,
      errors: outcomes.filter((outcome) => !outcome.ok).map((outcome) => ({ index: outcome.index, ...outcome.error })),
    },
  };
}
