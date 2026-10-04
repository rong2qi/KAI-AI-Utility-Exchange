#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStagingTarget } from '../src/adapters/local-staging-target.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/staging-target');

function collectSourceFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (['.git', 'coverage', 'evidence', 'node_modules'].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sourceFingerprint() {
  const entries = collectSourceFiles(packageRoot).map((absolute) => {
    const path = relative(packageRoot, absolute).split('\\').join('/');
    const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    return `${path}\0${digest}\n`;
  }).sort().join('');
  return { fileCount: entries.split('\n').filter(Boolean).length, sha256: createHash('sha256').update(entries).digest('hex') };
}

const startedAt = new Date();
const runId = `local-${startedAt.toISOString().replace(/[-:.TZ]/g, '')}`;
const evidencePath = join(evidenceDirectory, `${runId}.json`);
const rawLogPath = join(evidenceDirectory, `${runId}.log`);
const source = sourceFingerprint();
let status = 'passed';
let scenarios = [];
let error = null;

try {
  const target = new LocalStagingTarget({ healthByVersion: { v2: 'failed' } });
  const v1 = { version: 'v1', digest: 'digest-v1' };
  const v2 = { version: 'v2', digest: 'digest-v2' };
  scenarios.push({ name: 'target_declares_dry_run_boundary', result: await target.inspect() });
  scenarios.push({ name: 'activate_previous_artifact', result: await target.activate(v1) });
  scenarios.push({ name: 'activate_candidate_artifact', result: await target.activate(v2) });
  scenarios.push({ name: 'candidate_health_check_fails', result: await target.healthCheck(v2) });
  scenarios.push({ name: 'rollback_to_known_previous_artifact', result: await target.rollback({ ...v1, reason: 'health_check_failed' }) });
  scenarios.push({ name: 'target_reports_restored_artifact', result: await target.inspect() });
} catch (caught) {
  status = 'failed';
  error = { name: caught.name, code: caught.code || null, message: caught.message };
}

const finishedAt = new Date();
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
const evidence = {
  schemaVersion: 'kai-staging-target-evidence.v1',
  status,
  level: 'staging-target-rehearsal',
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  scope: {
    targetId: 'local-dry-run',
    networkDisabled: true,
    externalNetworkUsed: false,
    realStagingProof: false,
    productionProof: false,
    gitCommit: git.status === 0 ? git.stdout.trim() : null,
    sourceFingerprint: source,
  },
  scenarios,
  result: { error },
};

mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, artifacts: {
  evidenceFile: relative(packageRoot, evidencePath).split('\\').join('/'),
  rawLogFile: relative(packageRoot, rawLogPath).split('\\').join('/'),
} }, null, 2)}\n`);
writeFileSync(rawLogPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(join(evidenceDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-staging-target-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidencePath).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, rawLogPath).split('\\').join('/'),
  status,
  sourceFingerprint: source.sha256,
}, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (status !== 'passed') process.exitCode = 1;
