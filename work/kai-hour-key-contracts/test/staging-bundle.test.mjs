import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';

const packageRoot = new URL('..', import.meta.url).pathname;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/staging-bundle.mjs', ...args], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('staging bundle contains only the runtime boundary and a digest sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-bundle-'));
  const output = join(root, 'staging.tar.gz');
  try {
    const result = await run(['--version', 'v-test', '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    assert.equal(evidence.version, 'v-test');
    assert.match(evidence.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(evidence.files, ['src/staging-service.mjs', 'scripts/staging-service.mjs']);
    const listing = await runTarList(output);
    assert.deepEqual(listing, [...evidence.files].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staging bundle rejects unsafe versions and output names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-bundle-'));
  try {
    const unsafe = await run(['--version', '../escape', '--output', join(root, 'staging.tar.gz')]);
    assert.notEqual(unsafe.code, 0);
    const badOutput = await run(['--version', 'v1', '--output', join(root, 'other.tar.gz')]);
    assert.notEqual(badOutput.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runTarList(output) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => code === 0 ? resolve(stdout.trim().split('\n').sort()) : reject(new Error(stderr)));
  });
}
