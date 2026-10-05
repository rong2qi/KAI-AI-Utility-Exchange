#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DahonoRouterProviderAdapter,
  DAHONO_ROUTER_DEFAULT_ENDPOINT,
  DAHONO_ROUTER_MODEL,
} from '../src/adapters/dahono-router-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/dahono-provider');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const secretSourceArgument = rawArgs.find((argument) => argument.startsWith('--secret-source='));
const secretSource = secretSourceArgument ? secretSourceArgument.slice('--secret-source='.length) : 'env';
const unknownArguments = rawArgs.filter((argument) => argument !== '--confirm-live' && argument !== `--secret-source=${secretSource}`);

const sourceFingerprint = () => createHash('sha256')
  .update(readFileSync(fileURLToPath(new URL('../src/adapters/dahono-router-provider.mjs', import.meta.url))))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');

const writeEvidence = (evidence) => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const evidenceFile = join(evidenceDirectory, `live-${timestamp}.json`);
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(evidenceDirectory, 'LATEST-LIVE.json'), `${JSON.stringify({
    schemaVersion: 'kai-dahono-provider-live-pointer.v1',
    latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
    status: evidence.status,
    level: evidence.level,
  }, null, 2)}\n`);
  return relative(packageRoot, evidenceFile).split('\\').join('/');
};

const baseEvidence = {
  schemaVersion: 'kai-dahono-provider-live-evidence.v1',
  level: 'dahono-provider-live-smoke',
  provider: 'dahono-router',
  endpoint: DAHONO_ROUTER_DEFAULT_ENDPOINT,
  model: DAHONO_ROUTER_MODEL,
  requestCount: 0,
  sourceFingerprint: sourceFingerprint(),
  codeVersion: process.env.GITHUB_SHA || null,
  claim: '在有效预约窗口内，以受保护密钥完成一次 Dahono SSE 推理并得到用量与诊断头',
  doesNotProve: ['十路并发 SSE', '第十一路 429', '持续额度', '事务存储', '真实 staging 回滚', '生产安全'],
};

const outcome = (status, details = {}) => ({
  ...baseEvidence,
  status,
  claimStatus: status === 'passed' ? 'proven' : status === 'blocked' ? 'blocked' : 'failed',
  proves: status === 'passed' ? [baseEvidence.claim] : [],
  notProven: status === 'passed' ? [] : [baseEvidence.claim],
  ...details,
});

if (unknownArguments.length > 0) {
  const evidenceFile = writeEvidence(outcome('failed', { networkAttempted: false, httpResponseReceived: false, credentialsUsed: false, reason: 'UNKNOWN_ARGUMENT' }));
  console.error(`dahono_live_smoke=failed evidence=${evidenceFile}`);
  process.exitCode = 1;
} else if (secretSource !== 'env') {
  const evidenceFile = writeEvidence(outcome('failed', { networkAttempted: false, httpResponseReceived: false, credentialsUsed: false, reason: 'SECRET_SOURCE_NOT_ALLOWED' }));
  console.error(`dahono_live_smoke=failed evidence=${evidenceFile}`);
  process.exitCode = 1;
} else if (!args.has('--confirm-live')) {
  const evidenceFile = writeEvidence(outcome('blocked', { networkAttempted: false, httpResponseReceived: false, credentialsUsed: false, reason: 'EXPLICIT_LIVE_CONFIRMATION_REQUIRED' }));
  console.error(`dahono_live_smoke=blocked evidence=${evidenceFile}`);
  process.exitCode = 2;
} else {
  const requestId = `dahono-live-${randomUUID()}`;
  const idempotencyKey = `dahono-live-${randomUUID()}`;
  const keyResolver = () => process.env.DAHONO_API_KEY;
  const adapter = new DahonoRouterProviderAdapter({ apiKeyResolver: keyResolver, networkMode: 'live' });
  try {
    const result = await adapter.execute({
      model: DAHONO_ROUTER_MODEL,
      region: 'dahono-global',
      input: {
        messages: [{ role: 'user', content: 'Return exactly the word OK.' }],
        temperature: 0,
        user: 'kai-live-smoke',
      },
      requestId,
      idempotencyKey,
    });
    const evidenceFile = writeEvidence(outcome('passed', {
      requestCount: 1,
      networkAttempted: true,
      httpResponseReceived: true,
      credentialsUsed: true,
      providerRequestIdHash: createHash('sha256').update(result.providerRequestId).digest('hex').slice(0, 16),
      usage: result.usage,
      diagnostics: result.diagnostics,
      outputContentLength: typeof result.output?.content === 'string' ? result.output.content.length : null,
    }));
    console.log(`dahono_live_smoke=passed evidence=${evidenceFile}`);
  } catch (error) {
    const blocked = error?.code === 'PROVIDER_CREDENTIAL_REQUIRED'
      || error?.code === 'PROVIDER_CREDENTIAL_UNAVAILABLE'
      || error?.code === 'PROVIDER_WINDOW_CLOSED';
    const evidenceFile = writeEvidence(outcome(blocked ? 'blocked' : 'failed', {
      requestCount: blocked && error?.code?.startsWith('PROVIDER_CREDENTIAL') ? 0 : 1,
      networkAttempted: !error?.code?.startsWith('PROVIDER_CREDENTIAL'),
      httpResponseReceived: Number.isInteger(error?.status),
      credentialsUsed: !error?.code?.startsWith('PROVIDER_CREDENTIAL'),
      reason: error?.code || 'UNKNOWN',
      retryable: error?.retryable === true,
      statusCode: error?.status ?? null,
    }));
    console.error(`dahono_live_smoke=${blocked ? 'blocked' : 'failed'} reason=${error?.code || 'UNKNOWN'} evidence=${evidenceFile}`);
    process.exitCode = blocked ? 2 : 1;
  }
}
