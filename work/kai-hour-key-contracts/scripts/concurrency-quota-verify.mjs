#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConcurrencyQuotaAcceptance } from '../src/concurrency-quota-acceptance.mjs';
import { QuotaSandboxProviderAdapter } from '../src/adapters/quota-sandbox-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/provider-concurrency-quota');

const gitCommit = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const sourceFingerprint = () => createHash('sha256')
  .update(readFileSync(resolve(packageRoot, 'src/concurrency-quota-acceptance.mjs')))
  .update(readFileSync(resolve(packageRoot, 'src/adapters/quota-sandbox-provider.mjs')))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');

const request = (index) => ({
  model: 'model-a',
  region: 'region-a',
  input: { prompt: `quota-verification-${index}`, temperature: 0 },
  requestId: `quota-request-${index}`,
  idempotencyKey: `quota-idempotency-${index}`,
});

const adapter = new QuotaSandboxProviderAdapter({
  maxConcurrent: 10,
  maxRequests: 10,
  sandboxOptions: { latencyMs: 15 },
});
const result = await runConcurrencyQuotaAcceptance({ adapter, buildRequest: request, concurrencyLimit: 10 });
const evidence = {
  ...result,
  runId: `local-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`,
  scope: {
    ...result.scope,
    providerId: 'sandbox-provider-v1',
    nodeVersion: process.version,
    npmVersion: spawnSync('npm', ['--version'], { cwd: packageRoot, encoding: 'utf8' }).stdout.trim(),
    gitCommit: gitCommit(),
    sourceFingerprint: sourceFingerprint(),
  },
};

mkdirSync(evidenceDirectory, { recursive: true });
const evidenceFile = join(evidenceDirectory, `${evidence.runId}.json`);
writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(join(evidenceDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-provider-concurrency-quota-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  status: evidence.status,
}, null, 2)}\n`);

console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
