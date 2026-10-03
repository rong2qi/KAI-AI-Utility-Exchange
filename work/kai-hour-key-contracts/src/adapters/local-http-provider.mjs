import { createServer } from 'node:http';
import { SandboxProviderAdapter } from './sandbox-provider.mjs';

const MAX_BODY_BYTES = 64 * 1024;

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const statusForCode = (code) => ({
  IDEMPOTENCY_CONFLICT: 409,
  PROVIDER_SCOPE_UNSUPPORTED: 400,
  REQUEST_INVALID: 400,
  REQUEST_TOO_LARGE: 413,
  CONTENT_TYPE_UNSUPPORTED: 415,
  PROVIDER_REJECTED: 400,
  PROVIDER_TRANSIENT: 503,
  PROVIDER_TIMEOUT: 504,
}[code] || 500);

const retryableForStatus = (status) => status === 429 || status >= 500;

const respond = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

const readJsonBody = (request) => new Promise((resolve, reject) => {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (tooLarge) {
      reject(new ProviderHttpError('REQUEST_TOO_LARGE', 'Provider request body is too large'));
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      reject(new ProviderHttpError('REQUEST_INVALID', 'Provider request body is not valid JSON', { cause: error }));
    }
  });
  request.on('error', reject);
});

export class ProviderHttpError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderHttpError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class HttpProviderAdapter {
  constructor({ endpoint, providerId = 'sandbox-provider-v1', timeoutMs = 5_000 } = {}) {
    if (!endpoint) throw new Error('PROVIDER_ENDPOINT_REQUIRED');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PROVIDER_TIMEOUT_INVALID');
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' || parsed.pathname !== '/' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('LOCAL_PROVIDER_ENDPOINT_REQUIRED');
    }
    this.endpoint = parsed.toString().replace(/\/$/, '');
    this.providerId = providerId;
    this.timeoutMs = timeoutMs;
  }

  async execute(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.endpoint}/v1/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-provider-id': this.providerId,
          'x-request-id': request.requestId,
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ProviderHttpError('PROVIDER_TIMEOUT', 'Provider HTTP request timed out', { retryable: true, cause: error });
      }
      throw new ProviderHttpError('PROVIDER_UNAVAILABLE', 'Provider HTTP endpoint could not be reached', { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new ProviderHttpError('PROVIDER_RESPONSE_INVALID', 'Provider HTTP response is not valid JSON', {
        retryable: response.status >= 500,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ProviderHttpError(
        body?.code || 'PROVIDER_HTTP_ERROR',
        body?.message || 'Provider HTTP request failed',
        { retryable: body?.retryable ?? retryableForStatus(response.status) },
      );
    }
    return body;
  }
}

export async function startLocalProviderSandbox(options = {}) {
  const sandbox = new SandboxProviderAdapter(options);
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/execute') {
      respond(response, 404, { code: 'ROUTE_NOT_FOUND', message: 'Provider route was not found', retryable: false });
      return;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      respond(response, 415, { code: 'CONTENT_TYPE_UNSUPPORTED', message: 'Provider request must use application/json', retryable: false });
      return;
    }
    try {
      const payload = await readJsonBody(request);
      const result = await sandbox.execute(payload);
      respond(response, 200, clone(result));
    } catch (error) {
      const code = error?.code || 'PROVIDER_UNAVAILABLE';
      const status = statusForCode(code);
      respond(response, status, {
        code,
        message: error?.message || 'Provider sandbox failed',
        retryable: error?.retryable ?? retryableForStatus(status),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    sandbox,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
