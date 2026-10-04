#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/staging-rehearsal');

function collectSourceFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['.git', 'coverage', 'evidence', 'node_modules'].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const sourceEntries = collectSourceFiles(packageRoot).map((absolute) => {
  const path = relative(packageRoot, absolute).split('\\').join('/');
  const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  return `${path}\0${digest}\n`;
}).sort().join('');
const sourceFingerprint = createHash('sha256').update(sourceEntries).digest('hex');
const startedAt = new Date();
const runId = `local-${startedAt.toISOString().replace(/[-:.TZ]/g, '')}`;
const result = spawnSync(process.execPath, ['--test', 'test/staging-rehearsal.test.mjs'], {
  cwd: packageRoot,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});
const finishedAt = new Date();
const status = result.status === 0 ? 'passed' : 'failed';
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
const evidence = {
  schemaVersion: 'kai-staging-rehearsal-evidence.v1',
  status,
  level: 'staging-rehearsal',
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  scope: {
    networkDisabled: true,
    externalNetworkUsed: false,
    database: 'disposable-json-ledger-and-in-memory-fenced-transaction-model',
    productionProof: false,
    realStagingProof: false,
    gitCommit: git.status === 0 ? git.stdout.trim() : null,
    sourceFingerprint: { fileCount: sourceEntries.split('\n').filter(Boolean).length, sha256: sourceFingerprint },
  },
  scenarios: [
    'stale_worker_rejected_by_fence',
    'restart_recovery_reuses_provider_result',
    'immutable_artifact_activation_and_rollback',
  ],
  result: { command: 'node --test test/staging-rehearsal.test.mjs', exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null },
};

mkdirSync(evidenceDirectory, { recursive: true });
const evidenceFile = join(evidenceDirectory, `${runId}.json`);
const rawLogFile = join(evidenceDirectory, `${runId}.log`);
writeFileSync(evidenceFile, `${JSON.stringify({ ...evidence, artifacts: {
  evidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  rawLogFile: relative(packageRoot, rawLogFile).split('\\').join('/'),
} }, null, 2)}\n`);
writeFileSync(rawLogFile, `${result.stdout || ''}${result.stderr || ''}`);
writeFileSync(join(evidenceDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-staging-rehearsal-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, rawLogFile).split('\\').join('/'),
  status,
  sourceFingerprint,
}, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (result.status !== 0) process.exitCode = 1;
