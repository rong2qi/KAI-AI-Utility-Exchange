import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const ERROR_STATUS = {
  KEY_INVALID: 401, KEY_EXPIRED: 401, AUTHORIZATION_EXPIRED: 403, KEY_REVOKED: 403, CAPABILITY_DENIED: 403,
  SCOPE_EXPANSION_REQUIRED: 403, SLOT_NOT_ACTIVE: 409, HOLDING_EXHAUSTED: 409,
  IDEMPOTENCY_CONFLICT: 409, HOLDING_REQUIRED: 409, RECEIPT_NOT_FOUND: 404,
  PROVIDER_UNAVAILABLE: 503, EXECUTION_LEDGER_FAILED: 503, RECEIPT_WRITE_FAILED: 503,
  REQUEST_INVALID: 400, ROUTE_NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, REQUEST_TIMEOUT: 408,
  EXECUTION_TIMEOUT: 504, EXCHANGE_BUSY: 503, INTERNAL_ERROR: 500,
};
const POLICY_ERRORS = {
  DENY_KEY: 'KEY_INVALID', DENY_EXPIRED: 'AUTHORIZATION_EXPIRED', DENY_REVOKED: 'KEY_REVOKED',
  DENY_SCOPE: 'CAPABILITY_DENIED', DENY_CAPABILITY: 'CAPABILITY_DENIED',
  SCOPE_EXPANSION_REQUIRED: 'SCOPE_EXPANSION_REQUIRED', DENY_SLOT_NOT_ACTIVE: 'SLOT_NOT_ACTIVE',
};
const fail = (code) => Object.assign(new Error(code), { code });
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);

function singleHeader(request, name) {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count === 1 ? request.headers[name] : undefined;
}

function send(response, status, value, requestId) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'x-request-id': requestId, connection: 'close',
  });
  response.end(body);
}

function sendError(response, code, requestId) {
  const safeCode = Object.hasOwn(ERROR_STATUS, code) ? code : 'INTERNAL_ERROR';
  send(response, ERROR_STATUS[safeCode], {
    code: safeCode, message: safeCode.replaceAll('_', ' ').toLowerCase(), request_id: requestId,
    // A timeout does not prove non-execution. Retry only with the same idempotency key.
    retryable: ['EXCHANGE_BUSY', 'EXECUTION_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'EXECUTION_LEDGER_FAILED', 'RECEIPT_WRITE_FAILED'].includes(safeCode),
  }, requestId);
}

function readBody(request, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAbort);
      request.off('error', onError);
      if (error) {
        // Stop reading an unbounded body; response closes this connection.
        request.pause();
        reject(error);
      } else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) finish(fail('PAYLOAD_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () => finish(fail('REQUEST_INVALID'));
    const onError = () => finish(fail('REQUEST_INVALID'));
    const timer = setTimeout(() => finish(fail('REQUEST_TIMEOUT')), timeoutMs);
    request.on('data', onData).once('end', onEnd).once('aborted', onAbort).once('error', onError);
  });
}

function parseCompute(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail('REQUEST_INVALID');
  }
  if (!plain(value) || !identifier(value.holding_id) || !Object.hasOwn(value, 'input')) throw fail('REQUEST_INVALID');
  const allowed = new Set(['holding_id', 'input', 'model', 'provider', 'region']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw fail('REQUEST_INVALID');
  for (const key of ['model', 'provider', 'region']) {
    if (Object.hasOwn(value, key) && !identifier(value[key])) throw fail('REQUEST_INVALID');
  }
  // Bound recursive downstream hashing; JSON.parse also accepts overflowing numbers.
  const pending = [[value.input, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > 32 || (typeof node === 'number' && !Number.isFinite(node))) throw fail('REQUEST_INVALID');
    if (node && typeof node === 'object') for (const child of Object.values(node)) pending.push([child, depth + 1]);
  }
  return value;
}

/** Explicit public projection: no provider output or arbitrary adapter fields in a Receipt. */
function receiptJson(receipt) {
  return {
    receipt_id: receipt.receiptId, account_id: receipt.accountId, key_id: receipt.keyId,
    grant_id: receipt.grantId, holding_id: receipt.holdingId, offer_id: receipt.offerId,
    idempotency_key: receipt.idempotencyKey, hour_key_status: receipt.hourKeyStatus,
    resource: { model: receipt.resource.model, provider: receipt.resource.provider, region: receipt.resource.region },
    slot: { slot_start: receipt.slot.slotStart, lock_deadline: receipt.slot.lockDeadline, slot_end: receipt.slot.slotEnd, time_zone: receipt.slot.timeZone },
    request_hash: receipt.requestHash,
    usage: { input_units: receipt.usage.inputUnits, output_units: receipt.usage.outputUnits, total_units: receipt.usage.totalUnits },
    status: receipt.status, created_at: receipt.createdAt, source_url: receipt.sourceUrl,
  };
}

/** Local application entry. Runtime owns authorization/settlement; this module owns HTTP. */
export function createExchangeServer({ runtime, host = '127.0.0.1', port = 0, maxBodyBytes = 65536, bodyTimeoutMs = 5000, executionTimeoutMs = 30000, maxConcurrentRequests = 8 } = {}) {
  if (typeof runtime?.handle !== 'function' || host !== '127.0.0.1'
    || !Number.isInteger(port) || port < 0 || port > 65535
    || [maxBodyBytes, bodyTimeoutMs, executionTimeoutMs, maxConcurrentRequests].some((value) => !Number.isSafeInteger(value) || value < 1)
    || maxBodyBytes > 1048576 || maxConcurrentRequests > 64 || bodyTimeoutMs > 60000 || executionTimeoutMs > 300000) {
    throw new Error('EXCHANGE_CONFIG_INVALID');
  }
  let active = 0;
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const requestId = randomUUID();
    // Node emits errors after disconnect; no raw payload or headers are logged.
    request.on('error', () => {});
    response.on('error', () => {});
    const run = async () => {
      let admitted = false;
      let timer;
      try {
        const authorization = singleHeader(request, 'authorization');
        if (typeof authorization !== 'string' || !/^Bearer [\x21-\x7E]{1,4096}$/.test(authorization)) throw fail('KEY_INVALID');
        const opaqueKey = authorization.slice(7);
        const path = request.url;
        const receiptMatch = /^\/v1\/receipts\/([^/?#]+)$/.exec(path);
        let receiptId;
        if (receiptMatch) {
          try { receiptId = decodeURIComponent(receiptMatch[1]); } catch { throw fail('ROUTE_NOT_FOUND'); }
          if (!identifier(receiptId)) throw fail('ROUTE_NOT_FOUND');
        }
        const isCompute = path === '/v1/compute';
        if (!isCompute && !receiptMatch) throw fail('ROUTE_NOT_FOUND');
        if (request.method !== (isCompute ? 'POST' : 'GET')) throw fail('METHOD_NOT_ALLOWED');
        if (active >= maxConcurrentRequests) throw fail('EXCHANGE_BUSY');
        active++;
        admitted = true;
        let command;
        if (isCompute) {
          const contentType = singleHeader(request, 'content-type');
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? '')
            || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) throw fail('UNSUPPORTED_MEDIA_TYPE');
          const idempotencyKey = singleHeader(request, 'idempotency-key');
          if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw fail('REQUEST_INVALID');
          const body = parseCompute(await readBody(request, maxBodyBytes, bodyTimeoutMs));
          if (request.aborted || response.destroyed) return;
          command = {
            requestId, opaqueKey, userText: '执行计算', holdingId: body.holding_id, idempotencyKey,
            providerInput: body.input, requestedResource: { model: body.model, provider: body.provider, region: body.region },
          };
        } else {
          if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) throw fail('REQUEST_INVALID');
          command = { requestId, opaqueKey, userText: 'receipt', receiptId };
        }
        timer = setTimeout(() => sendError(response, 'EXECUTION_TIMEOUT', requestId), executionTimeoutMs);
        // A response timeout/disconnect must not release admission for still-running work.
        const result = await runtime.handle(command);
        if (result?.kind === 'error') return sendError(response, result.error?.code, requestId);
        if (result?.kind === 'policy') return sendError(response, POLICY_ERRORS[result.decision?.code] ?? 'CAPABILITY_DENIED', requestId);
        if (result?.kind !== 'receipt' || (isCompute && !Object.hasOwn(result, 'output'))) throw fail('INTERNAL_ERROR');
        const receipt = receiptJson(result.receipt);
        send(response, 200, isCompute ? { output: result.output, receipt } : receipt, requestId);
      } catch (error) {
        sendError(response, error?.code, requestId);
      } finally {
        clearTimeout(timer);
        if (admitted) active--;
      }
    };
    void run();
  });
  server.headersTimeout = 10000;
  server.requestTimeout = bodyTimeoutMs + 10000;
  return {
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => { server.off('error', onError); resolve(); });
    }),
    address: () => { const address = server.address(); return address ? `http://${host}:${address.port}` : undefined; },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
