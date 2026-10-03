#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function readOption(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: [command, ...commandArgs].join(' '),
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error) : null,
  };
}

function collectSourceFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['.git', 'coverage', 'evidence', 'node_modules'].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, files);
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function hashSource() {
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
}

function gitRef() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  return null;
}

const startedAt = new Date();
const timestamp = startedAt.toISOString().replace(/[-:.TZ]/g, '');
const runId = process.env.GITHUB_RUN_ID
  ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
  : `local-${timestamp}`;
const outputDirectory = resolve(packageRoot, readOption('--output-dir', 'evidence/ci'));
const source = hashSource();
const nodeVersion = process.version;
const npm = run('npm', ['--version']);
const tests = run('npm', ['test']);
const finishedAt = new Date();
const status = tests.exitCode === 0 ? 'passed' : 'failed';
const evidence = {
  schemaVersion: 'kai-ci-evidence.v1',
  status,
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  scope: {
    package: 'kai-hour-key-contracts',
    command: 'npm test',
    nodeVersion,
    npmVersion: npm.stdout.trim() || null,
    gitCommit: gitRef(),
    sourceFingerprint: source,
  },
  result: {
    exitCode: tests.exitCode,
    signal: tests.signal,
    error: tests.error,
  },
  evidencePolicy: {
    rawLogRequired: true,
    sourceFingerprintExcludes: ['.git', 'coverage', 'evidence', 'node_modules'],
    secretHandling: 'verifier does not inject secrets; consumers must review raw logs',
  },
};

mkdirSync(outputDirectory, { recursive: true });
const evidenceFileName = `${runId}.json`;
const logFileName = `${runId}.log`;
const evidencePath = join(outputDirectory, evidenceFileName);
const logPath = join(outputDirectory, logFileName);
const log = [
  `run_id=${runId}`,
  `status=${status}`,
  `command=${tests.command}`,
  `started_at=${startedAt.toISOString()}`,
  `finished_at=${finishedAt.toISOString()}`,
  `node=${nodeVersion}`,
  `npm=${npm.stdout.trim()}`,
  `source_sha256=${source.sha256}`,
  `source_file_count=${source.fileCount}`,
  `exit_code=${tests.exitCode}`,
  '',
  '--- stdout ---',
  tests.stdout,
  '--- stderr ---',
  tests.stderr,
].join('\n');

evidence.artifacts = {
  evidenceFile: relative(packageRoot, evidencePath).split('\\').join('/'),
  rawLogFile: relative(packageRoot, logPath).split('\\').join('/'),
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(logPath, log);
writeFileSync(join(outputDirectory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-ci-evidence-pointer.v1',
  latestEvidenceFile: evidence.artifacts.evidenceFile,
  latestRawLogFile: evidence.artifacts.rawLogFile,
  status,
  sourceFingerprint: source.sha256,
}, null, 2)}\n`);

console.log(JSON.stringify(evidence, null, 2));
if (tests.exitCode !== 0) process.exitCode = 1;
