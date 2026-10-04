import { createServer } from 'node:http';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18_971;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

export class StagingServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingServiceError';
    this.code = code;
  }
}

const validIdentity = (version, digest) => typeof version === 'string'
  && VERSION_PATTERN.test(version)
  && version !== '.'
  && version !== '..'
  && typeof digest === 'string'
  && DIGEST_PATTERN.test(digest);

const identityFrom = (options) => {
  const version = options?.version;
  const digest = options?.digest;
  if (!validIdentity(version, digest)) {
    throw new StagingServiceError('STAGING_IDENTITY_INVALID', 'version must be a safe identifier and digest must be a 64-character hexadecimal SHA-256 value');
  }
  return { version, digest };
};

const portFrom = (value) => {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new StagingServiceError('STAGING_PORT_INVALID', 'port must be an integer between 0 and 65535');
  }
  return port;
};

const json = (response, statusCode, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

export function createStagingServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    throw new StagingServiceError('STAGING_HOST_INVALID', 'staging service only listens on 127.0.0.1');
  }
  const identity = identityFrom(options);
  const port = portFrom(options.port);
  const healthy = options.healthy ?? true;
  if (typeof healthy !== 'boolean') {
    throw new StagingServiceError('STAGING_HEALTH_INVALID', 'healthy must be a boolean');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new StagingServiceError('STAGING_TIMEOUT_INVALID', 'requestTimeoutMs must be a positive integer');
  }

  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (request.url === '/version') {
      json(response, 200, identity);
      return;
    }
    if (request.url === '/healthz') {
      if (healthy) {
        json(response, 200, { status: 'ok', ...identity });
      } else {
        json(response, 503, { status: 'failed', ...identity, reason: 'configured_unhealthy' });
      }
      return;
    }
    json(response, 404, { error: 'NOT_FOUND' });
  });

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.max(requestTimeoutMs, 1_000);
  server.keepAliveTimeout = Math.min(requestTimeoutMs, 5_000);

  return {
    address: () => {
      const address = server.address();
      if (!address || typeof address === 'string') return null;
      return `http://${host}:${address.port}`;
    },
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }),
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    }),
    identity: { ...identity },
    host,
    port,
  };
}
