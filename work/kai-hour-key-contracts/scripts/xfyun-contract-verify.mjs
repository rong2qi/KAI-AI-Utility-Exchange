#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = resolve(packageRoot, 'evidence/upstream-provider-contract');

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
const result = spawnSync(process.execPath, ['--test', 'test/xfyun-spark-provider.test.mjs'], {
  cwd: packageRoot,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});
const finishedAt = new Date();
const status = result.status === 0 ? 'passed' : 'failed';
const evidence = {
  schemaVersion: 'kai-provider-contract-evidence.v1',
  status,
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  level: 'upstream-provider-contract',
  provider: 'xfyun-spark-chat',
  endpoint: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
  networkDisabled: true,
  credentialsUsed: false,
  result: { exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null },
  source: { gitCommit: (() => {
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
    return git.status === 0 ? git.stdout.trim() : null;
  })(), sourceFingerprint, sourceFileCount: sourceEntries.split('\n').filter(Boolean).length },
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
  schemaVersion: 'kai-provider-contract-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, rawLogFile).split('\\').join('/'),
  status,
  sourceFingerprint,
}, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (result.status !== 0) process.exitCode = 1;
