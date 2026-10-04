#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XfyunSparkProviderAdapter,
  XFYUN_SPARK_DEFAULT_ENDPOINT,
  XFYUN_SPARK_SUPPORTED_MODELS,
  createMacKeychainApiKeyResolver,
} from '../src/adapters/xfyun-spark-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/upstream-provider-live');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const modelArgument = rawArgs.find((argument) => argument.startsWith('--model='));
const secretSourceArgument = rawArgs.find((argument) => argument.startsWith('--secret-source='));
const model = modelArgument ? modelArgument.slice('--model='.length) : 'spark-x2.5';
const secretSource = secretSourceArgument ? secretSourceArgument.slice('--secret-source='.length) : 'keychain';
const unknownArguments = rawArgs.filter((argument) => argument !== '--confirm-live'
  && argument !== `--model=${model}`
  && argument !== `--secret-source=${secretSource}`);

const sourceFingerprint = () => createHash('sha256')
  .update(readFileSync(fileURLToPath(new URL('../src/adapters/xfyun-spark-provider.mjs', import.meta.url))))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');

const writeEvidence = (evidence) => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const evidenceFile = join(evidenceDirectory, `local-${timestamp}.json`);
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(evidenceDirectory, 'LATEST.json'), `${JSON.stringify({
    schemaVersion: 'kai-provider-live-pointer.v1',
    latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
    status: evidence.status,
    level: evidence.level,
  }, null, 2)}\n`);
  return relative(packageRoot, evidenceFile).split('\\').join('/');
};

const baseEvidence = {
  schemaVersion: 'kai-provider-live-evidence.v1',
  level: 'upstream-provider-live-smoke',
  provider: 'xfyun-spark-chat',
  endpoint: XFYUN_SPARK_DEFAULT_ENDPOINT,
  model,
  requestCount: 1,
  assuranceLevel: 'live-smoke',
  proves: ['单次最小请求在某时刻到达讯飞并得到有效响应'],
  doesNotProve: ['生产可用性', 'staging 事务与回滚', '额度持续可用性', '供应商 exactly-once 幂等'],
  upstreamIdempotency: 'unsupported',
  retryCount: 0,
  productionProof: false,
  stagingProof: false,
  input: 'synthetic-fixed-prompt',
  secretSource,
  sourceFingerprint: sourceFingerprint(),
  codeVersion: process.env.GITHUB_SHA || null,
};

if (unknownArguments.length > 0) {
  const evidenceFile = writeEvidence({
    ...baseEvidence,
    status: 'failed',
    networkAttempted: false,
    httpResponseReceived: false,
    credentialsUsed: false,
    reason: 'UNKNOWN_ARGUMENT',
  });
  console.error(`live_smoke=failed evidence=${evidenceFile}`);
  process.exitCode = 1;
} else if (!['keychain', 'env'].includes(secretSource)) {
  const evidenceFile = writeEvidence({
    ...baseEvidence,
    status: 'failed',
    networkAttempted: false,
    httpResponseReceived: false,
    credentialsUsed: false,
    reason: 'SECRET_SOURCE_NOT_ALLOWED',
  });
  console.error(`live_smoke=failed evidence=${evidenceFile}`);
  process.exitCode = 1;
} else if (!args.has('--confirm-live')) {
  const evidenceFile = writeEvidence({
    ...baseEvidence,
    status: 'blocked',
    networkAttempted: false,
    httpResponseReceived: false,
    credentialsUsed: false,
    reason: 'EXPLICIT_LIVE_CONFIRMATION_REQUIRED',
  });
  console.error(`live_smoke=blocked evidence=${evidenceFile}`);
  process.exitCode = 2;
} else if (!XFYUN_SPARK_SUPPORTED_MODELS.includes(model)) {
  const evidenceFile = writeEvidence({
    ...baseEvidence,
    status: 'failed',
    networkAttempted: false,
    httpResponseReceived: false,
    credentialsUsed: false,
    reason: 'MODEL_NOT_SUPPORTED',
  });
  console.error(`live_smoke=failed evidence=${evidenceFile}`);
  process.exitCode = 1;
} else {
  const requestId = `xfyun-live-${randomUUID()}`;
  const idempotencyKey = `xfyun-live-${randomUUID()}`;
  const keyResolver = secretSource === 'env'
    ? () => process.env.XFYUN_API_KEY
    : createMacKeychainApiKeyResolver();
  const adapter = new XfyunSparkProviderAdapter({ apiKeyResolver: keyResolver, networkMode: 'live' });
  try {
    const result = await adapter.execute({
      model,
      region: 'cn-huabei-1',
      input: {
        messages: [{ role: 'user', content: 'Return exactly the word OK.' }],
        user: 'kai-live-smoke',
        thinking: { type: 'disabled' },
      },
      requestId,
      idempotencyKey,
    });
    const evidenceFile = writeEvidence({
      ...baseEvidence,
      status: 'passed',
      networkAttempted: true,
      httpResponseReceived: true,
      credentialsUsed: true,
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      outputContentLength: typeof result.output?.content === 'string' ? result.output.content.length : null,
    });
    console.log(`live_smoke=passed provider_request_id=${result.providerRequestId} evidence=${evidenceFile}`);
  } catch (error) {
    const credentialError = error?.code === 'PROVIDER_CREDENTIAL_REQUIRED' || error?.code === 'PROVIDER_CREDENTIAL_UNAVAILABLE';
    const evidenceFile = writeEvidence({
      ...baseEvidence,
      status: credentialError ? 'blocked' : 'failed',
      networkAttempted: !credentialError,
      httpResponseReceived: Number.isInteger(error?.status),
      credentialsUsed: !credentialError,
      error: { code: error?.code || 'UNKNOWN', retryable: error?.retryable === true, status: error?.status ?? null },
    });
    console.error(`live_smoke=${credentialError ? 'blocked' : 'failed'} code=${error?.code || 'UNKNOWN'} evidence=${evidenceFile}`);
    process.exitCode = credentialError ? 2 : 1;
  }
}
