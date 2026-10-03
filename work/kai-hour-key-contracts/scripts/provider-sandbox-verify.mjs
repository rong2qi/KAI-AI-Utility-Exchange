#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderSandboxError, SandboxProviderAdapter } from '../src/adapters/sandbox-provider.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const request = (overrides = {}) => ({
  model: 'model-a',
  region: 'region-a',
  input: { prompt: 'sandbox verification', temperature: 0 },
  requestId: 'sandbox-request-1',
  idempotencyKey: 'sandbox-idempotency-1',
  ...overrides,
});

const gitCommit = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const collectSourceFiles = (directory, files = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['.git', 'coverage', 'evidence', 'node_modules'].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
};

const sourceFingerprint = () => {
  const entries = collectSourceFiles(packageRoot)
    .map((absolute) => {
      const path = relative(packageRoot, absolute).split('\\').join('/');
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      return `${path}\0${digest}\n`;
    })
    .sort()
    .join('');
  return {
    fileCount: entries ? entries.split('\n').filter(Boolean).length : 0,
    sha256: createHash('sha256').update(entries).digest('hex'),
  };
};

const scenarios = [];
const startedAt = new Date();
const record = (name, outcome, details = {}) => scenarios.push({ name, outcome, ...details });

const success = new SandboxProviderAdapter();
const first = await success.execute(request());
const replay = await success.execute(request({ requestId: 'sandbox-request-retry' }));
record('success_and_replay', first.status === 'succeeded' && replay.providerRequestId === first.providerRequestId ? 'passed' : 'failed', {
  executions: success.executions,
  calls: success.calls,
});

try {
  await success.execute(request({ input: { prompt: 'changed' } }));
  record('idempotency_conflict', 'failed');
} catch (error) {
  record('idempotency_conflict', error instanceof ProviderSandboxError && error.code === 'IDEMPOTENCY_CONFLICT' ? 'passed' : 'failed', {
    code: error?.code || null,
  });
}

const transient = new SandboxProviderAdapter({ profile: 'transient_failure' });
try {
  await transient.execute(request({ idempotencyKey: 'sandbox-transient-1' }));
  record('transient_recovery', 'failed');
} catch (error) {
  const recovered = await transient.execute(request({ idempotencyKey: 'sandbox-transient-1', requestId: 'sandbox-transient-retry' }));
  record('transient_recovery', error.code === 'PROVIDER_TRANSIENT' && recovered.status === 'succeeded' ? 'passed' : 'failed', {
    firstCode: error?.code || null,
  });
}

const timeout = new SandboxProviderAdapter({ profile: 'timeout' });
try {
  await timeout.execute(request({ idempotencyKey: 'sandbox-timeout-1' }));
  record('timeout_mapping', 'failed');
} catch (error) {
  record('timeout_mapping', error.code === 'PROVIDER_TIMEOUT' && error.retryable === true ? 'passed' : 'failed', {
    code: error?.code || null,
  });
}

const malformed = await new SandboxProviderAdapter({ profile: 'malformed_result' }).execute(request({ idempotencyKey: 'sandbox-malformed-1' }));
record('malformed_result_is_visible', malformed.status === 'unknown' && malformed.usage === undefined ? 'passed' : 'failed', {
  status: malformed.status,
});

const failed = scenarios.filter((scenario) => scenario.outcome !== 'passed');
const startedAtText = startedAt.toISOString();
const runId = `local-${startedAtText.replace(/[-:.TZ]/g, '')}`;
const outputDirectory = resolve(packageRoot, option('--output-dir', 'evidence/provider-sandbox'));
const evidence = {
  schemaVersion: 'kai-provider-sandbox-evidence.v1',
  status: failed.length === 0 ? 'passed' : 'failed',
  level: 'internal-provider-sandbox',
  runId,
  startedAt: startedAtText,
  scope: {
    providerId: 'sandbox-provider-v1',
    networkDisabled: true,
    credentialsUsed: false,
    nodeVersion: process.version,
    npmVersion: spawnSync('npm', ['--version'], { cwd: packageRoot, encoding: 'utf8' }).stdout.trim(),
    gitCommit: gitCommit(),
    sourceFingerprint: sourceFingerprint(),
  },
  scenarios,
};
mkdirSync(outputDirectory, { recursive: true });
const evidenceFile = join(outputDirectory, `${runId}.json`);
const logFile = join(outputDirectory, `${runId}.log`);
writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(logFile, scenarios.map((scenario) => `${scenario.name}=${scenario.outcome}`).join('\n') + '\n');
writeFileSync(join(outputDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-provider-sandbox-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, logFile).split('\\').join('/'),
  status: evidence.status,
}, null, 2)}\n`);

console.log(JSON.stringify(evidence, null, 2));
if (failed.length > 0) process.exitCode = 1;
