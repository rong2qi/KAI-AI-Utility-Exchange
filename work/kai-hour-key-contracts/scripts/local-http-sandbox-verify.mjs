#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageRoot, 'evidence/local-http-sandbox');

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

const gitCommit = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const startedAt = new Date();
const runId = `local-${startedAt.toISOString().replace(/[-:.TZ]/g, '')}`;
const testRun = spawnSync(process.execPath, ['--test', 'test/local-http-sandbox.test.mjs'], {
  cwd: packageRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const status = testRun.status === 0 ? 'passed' : 'failed';
const evidence = {
  schemaVersion: 'kai-local-http-sandbox-evidence.v1',
  status,
  level: 'local-http-sandbox',
  runId,
  startedAt: startedAt.toISOString(),
  scope: {
    endpointScope: '127.0.0.1-only',
    externalNetworkUsed: false,
    credentialsUsed: false,
    nodeVersion: process.version,
    npmVersion: spawnSync('npm', ['--version'], { cwd: packageRoot, encoding: 'utf8' }).stdout.trim(),
    gitCommit: gitCommit(),
    sourceFingerprint: sourceFingerprint(),
  },
  result: {
    command: 'node --test test/local-http-sandbox.test.mjs',
    exitCode: testRun.status,
    signal: testRun.signal,
    error: testRun.error ? String(testRun.error) : null,
  },
};

mkdirSync(outputDirectory, { recursive: true });
const evidenceFile = join(outputDirectory, `${runId}.json`);
const logFile = join(outputDirectory, `${runId}.log`);
writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(logFile, [testRun.stdout || '', testRun.stderr || ''].join('\n'));
writeFileSync(join(outputDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-local-http-sandbox-pointer.v1',
  latestEvidenceFile: relative(packageRoot, evidenceFile).split('\\').join('/'),
  latestRawLogFile: relative(packageRoot, logFile).split('\\').join('/'),
  status,
}, null, 2)}\n`);

console.log(JSON.stringify(evidence, null, 2));
if (status !== 'passed') process.exitCode = 1;
