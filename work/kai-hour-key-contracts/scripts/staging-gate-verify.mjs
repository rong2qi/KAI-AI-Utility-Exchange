#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StagingArtifactRegistry,
  StagingDeploymentController,
  StagingFence,
  artifactDigest,
} from '../src/staging-rehearsal.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/staging-gate');

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

const manifestFor = (version, contents) => ({
  version,
  sourceCommit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
  packageLockSha256: 'c'.repeat(64),
  nodeRange: '>=22.0.0 <25.0.0',
  providerModel: 'spark-x2.5-4b',
  artifactSha256: artifactDigest(contents),
  createdAt: '2026-10-04T02:00:00.000Z',
});

const startedAt = new Date();
const runId = `local-${startedAt.toISOString().replace(/[-:.TZ]/g, '')}`;
const evidencePath = join(evidenceDirectory, `${runId}.json`);
const rawLogPath = join(evidenceDirectory, `${runId}.log`);
const source = sourceFingerprint();
let status = 'passed';
let scenarios = [];
let error = null;

try {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const token = fence.acquire('staging-gate-verifier');
  const v1 = { version: 'v1', contents: 'artifact-v1', manifest: manifestFor('v1', 'artifact-v1') };
  const v2 = { version: 'v2', contents: 'artifact-v2', manifest: manifestFor('v2', 'artifact-v2') };
  const v3 = { version: 'v3', contents: 'artifact-v3', manifest: manifestFor('v3', 'artifact-v3') };
  await registry.publish({ ...v1 }, token);
  await registry.publish({ ...v2 }, token);
  await registry.publish({ ...v3 }, token);

  const activation = await controller.release({
    manifest: v1.manifest,
    checks: [
      { name: 'startup', status: 'passed', required: true },
      { name: 'contract', status: 'passed', required: true },
      { name: 'provider-sandbox', status: 'warning', required: false, detail: 'sandbox only' },
    ],
    token,
  });
  scenarios.push({ name: 'required_checks_pass_activate', decision: activation.decision, gateId: activation.gateId, manifest: activation.manifest, checks: activation.checks, candidateDigest: activation.digest, activeDigest: activation.digest, previousDigest: null });

  const rollback = await controller.release({
    manifest: v2.manifest,
    checks: [{ name: 'startup', status: 'passed', required: true }, { name: 'contract', status: 'failed', required: true, detail: 'contract mismatch' }],
    token,
  });
  scenarios.push({ name: 'required_check_failed_rollback', decision: rollback.decision, reasonCode: rollback.reasonCode, gateId: rollback.gateId, manifest: rollback.manifest, checks: rollback.checks, candidateDigest: rollback.manifest.artifactSha256, activeDigest: rollback.rollbackTo.digest, previousDigest: rollback.rollbackTo.digest });

  const emptyFence = new StagingFence();
  const emptyRegistry = new StagingArtifactRegistry({ fence: emptyFence });
  const emptyController = new StagingDeploymentController({ registry: emptyRegistry });
  const emptyToken = emptyFence.acquire('staging-gate-blocked-verifier');
  await emptyRegistry.publish({ ...v3 }, emptyToken);
  const blocked = await emptyController.release({
    manifest: v3.manifest,
    checks: [{ name: 'startup', status: 'failed', required: true }],
    token: emptyToken,
  });
  scenarios.push({ name: 'failed_check_without_previous_blocks', decision: blocked.decision, reasonCode: blocked.reasonCode, gateId: blocked.gateId, manifest: blocked.manifest, checks: blocked.checks, candidateDigest: blocked.manifest.artifactSha256, activeDigest: null, previousDigest: null });
} catch (caught) {
  status = 'failed';
  error = { name: caught.name, code: caught.code || null, message: caught.message };
}

const finishedAt = new Date();
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
const evidence = {
  schemaVersion: 'kai-staging-gate-evidence.v1',
  status,
  level: 'staging-gate-rehearsal',
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  scope: {
    networkDisabled: true,
    externalNetworkUsed: false,
    database: 'in-memory-fenced-artifact-registry',
    productionProof: false,
    realStagingProof: false,
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
  schemaVersion: 'kai-staging-gate-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidencePath).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, rawLogPath).split('\\').join('/'),
  status,
  sourceFingerprint: source.sha256,
}, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (status !== 'passed') process.exitCode = 1;
