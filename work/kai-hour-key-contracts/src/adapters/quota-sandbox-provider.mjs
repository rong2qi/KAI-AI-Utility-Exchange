import { SandboxProviderAdapter } from './sandbox-provider.mjs';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const isUsage = (usage) => usage
  && Number.isSafeInteger(usage.inputUnits)
  && Number.isSafeInteger(usage.outputUnits)
  && Number.isSafeInteger(usage.totalUnits)
  && usage.inputUnits >= 0
  && usage.outputUnits >= 0
  && usage.totalUnits === usage.inputUnits + usage.outputUnits;

export class QuotaSandboxProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'QuotaSandboxProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Local-only quota gate around the existing deterministic sandbox adapter.
 * It models provider admission without credentials or network access.
 */
export class QuotaSandboxProviderAdapter {
  constructor({
    maxConcurrent = 10,
    maxRequests = maxConcurrent,
    sandboxOptions = {},
  } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('QUOTA_MAX_CONCURRENT_INVALID');
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('QUOTA_MAX_REQUESTS_INVALID');
    this.maxConcurrent = maxConcurrent;
    this.maxRequests = maxRequests;
    this.sandbox = new SandboxProviderAdapter(sandboxOptions);
    this.providerId = this.sandbox.providerId;
    this.active = 0;
    this.peakConcurrency = 0;
    this.acceptedRequests = 0;
    this.rateLimitedRequests = 0;
    this.usage = { inputUnits: 0, outputUnits: 0, totalUnits: 0 };
  }

  async execute(request) {
    if (this.active >= this.maxConcurrent || this.acceptedRequests >= this.maxRequests) {
      this.rateLimitedRequests += 1;
      throw new QuotaSandboxProviderError(
        'PROVIDER_RATE_LIMITED',
        'Local provider quota rejected the request',
        { retryable: true },
      );
    }
    this.active += 1;
    this.acceptedRequests += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
    try {
      const result = await this.sandbox.execute(request);
      if (!isUsage(result?.usage)) throw new QuotaSandboxProviderError('PROVIDER_RESPONSE_INVALID', 'Local provider returned invalid usage');
      this.usage = {
        inputUnits: this.usage.inputUnits + result.usage.inputUnits,
        outputUnits: this.usage.outputUnits + result.usage.outputUnits,
        totalUnits: this.usage.totalUnits + result.usage.totalUnits,
      };
      return clone(result);
    } finally {
      this.active -= 1;
    }
  }
}
