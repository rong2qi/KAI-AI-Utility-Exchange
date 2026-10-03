import { createHash } from 'node:crypto';

export const PROVIDER_SANDBOX_PROFILES = Object.freeze([
  'success',
  'transient_failure',
  'timeout',
  'permanent_failure',
  'malformed_result',
]);

const DEFAULT_MODELS = Object.freeze(['model-a']);
const DEFAULT_REGIONS = Object.freeze(['region-a']);

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const stableSerialize = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const requestFingerprint = ({ model, region, input }) => createHash('sha256')
  .update(stableSerialize({ input, model, region }))
  .digest('hex');

const delay = (milliseconds) => milliseconds > 0
  ? new Promise((resolve) => setTimeout(resolve, milliseconds))
  : Promise.resolve();

export class ProviderSandboxError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'ProviderSandboxError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Deterministic, in-process ProviderAdapterPort implementation.
 * It never opens a network connection or reads credentials.
 */
export class SandboxProviderAdapter {
  constructor({
    providerId = 'sandbox-provider-v1',
    supportedModels = DEFAULT_MODELS,
    supportedRegions = DEFAULT_REGIONS,
    profile = 'success',
    latencyMs = 0,
    timeoutMs = 5_000,
    seed = 'sandbox-v1',
  } = {}) {
    if (!PROVIDER_SANDBOX_PROFILES.includes(profile)) throw new Error('SANDBOX_PROFILE_INVALID');
    if (!providerId) throw new Error('SANDBOX_PROVIDER_ID_REQUIRED');
    if (!Array.isArray(supportedModels) || supportedModels.length === 0) throw new Error('SANDBOX_MODELS_REQUIRED');
    if (!Array.isArray(supportedRegions) || supportedRegions.length === 0) throw new Error('SANDBOX_REGIONS_REQUIRED');
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('SANDBOX_LATENCY_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('SANDBOX_TIMEOUT_INVALID');

    this.providerId = providerId;
    this.supportedModels = new Set(supportedModels);
    this.supportedRegions = new Set(supportedRegions);
    this.profile = profile;
    this.latencyMs = latencyMs;
    this.timeoutMs = timeoutMs;
    this.seed = seed;
    this.calls = 0;
    this.executions = 0;
    this.idempotency = new Map();
    this.transientFailures = new Set();
  }

  async execute(request) {
    this.calls += 1;
    this.#validateRequest(request);
    if (!this.supportedModels.has(request.model) || !this.supportedRegions.has(request.region)) {
      throw new ProviderSandboxError(
        'PROVIDER_SCOPE_UNSUPPORTED',
        'Sandbox model or region is outside the configured test scope',
      );
    }

    const fingerprint = requestFingerprint(request);
    const previous = this.idempotency.get(request.idempotencyKey);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new ProviderSandboxError(
        'IDEMPOTENCY_CONFLICT',
        'Sandbox idempotency key was reused with different request facts',
      );
    }
    if (previous) return clone(previous.result);

    if (this.profile === 'transient_failure' && !this.transientFailures.has(request.idempotencyKey)) {
      this.transientFailures.add(request.idempotencyKey);
      throw new ProviderSandboxError('PROVIDER_TRANSIENT', 'Sandbox transient failure', { retryable: true });
    }
    if (this.profile === 'timeout' || this.latencyMs > this.timeoutMs) {
      await delay(Math.min(this.latencyMs, this.timeoutMs));
      throw new ProviderSandboxError('PROVIDER_TIMEOUT', 'Sandbox execution exceeded its timeout', { retryable: true });
    }
    if (this.profile === 'permanent_failure') {
      throw new ProviderSandboxError('PROVIDER_REJECTED', 'Sandbox permanently rejected the request');
    }
    await delay(this.latencyMs);

    const providerRequestId = `${this.providerId}_${this.seedHash(fingerprint)}`;
    if (this.profile === 'malformed_result') {
      return { providerRequestId, status: 'unknown' };
    }

    const serializedInput = stableSerialize(request.input);
    const result = {
      providerRequestId,
      output: {
        providerId: this.providerId,
        model: request.model,
        region: request.region,
        echo: clone(request.input),
      },
      usage: {
        inputUnits: Math.max(1, Math.ceil(serializedInput.length / 16)),
        outputUnits: 1,
        totalUnits: Math.max(2, Math.ceil(serializedInput.length / 16) + 1),
      },
      status: 'succeeded',
    };
    this.idempotency.set(request.idempotencyKey, { fingerprint, result: clone(result) });
    this.executions += 1;
    return clone(result);
  }

  #validateRequest(request) {
    if (!request || typeof request !== 'object') throw new ProviderSandboxError('REQUEST_INVALID', 'Sandbox request is required');
    if (!request.model || !request.region || request.idempotencyKey?.length < 8) {
      throw new ProviderSandboxError('REQUEST_INVALID', 'Sandbox model, region, and idempotency key are required');
    }
  }

  seedHash(fingerprint) {
    return createHash('sha256').update(`${this.seed}:${fingerprint}`).digest('hex').slice(0, 16);
  }
}
