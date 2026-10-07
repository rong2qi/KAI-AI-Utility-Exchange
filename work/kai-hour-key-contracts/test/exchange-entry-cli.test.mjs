import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/exchange-sandbox-verify.mjs', import.meta.url);
test('one-command Exchange acceptance preserves counters and source evidence without private output', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'exchange-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script.pathname, '--output-dir', directory], { encoding: 'utf8', timeout: 10000, env: { ...process.env, DAHONO_API_KEY: 'must-not-read-provider-key' } });
  assert.equal(run.status, 0, run.stderr);
  const pointer = JSON.parse(readFileSync(join(directory, 'LATEST.json'), 'utf8'));
  const text = readFileSync(join(directory, pointer.file), 'utf8');
  const evidence = JSON.parse(text);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.externalProviderCalls, 0);
  assert.equal(evidence.transport, 'http-loopback');
  assert.equal(evidence.results.length, 8);
  assert.equal(evidence.reservationAcceptance.status, 'passed');
  assert.equal(evidence.reservationAcceptance.peakConcurrentCalls, 2);
  assert.equal(evidence.reservationAcceptance.during.reserved, 2);
  assert.equal(evidence.reservationAcceptance.after.committed, 2);
  assert.deepEqual(evidence.counters, { providerCalls: 1, providerExecutions: 1, unitsRemaining: 0, receiptCount: 1 });
  assert.equal(evidence.source.files.length > 10, true);
  for (const forbidden of ['EXCHANGE_PRIVATE_BODY_MARKER', 'must-not-read-provider-key', 'Bearer ', 'echo']) {
    assert.equal((text + run.stdout + run.stderr).includes(forbidden), false);
  }
});

test('acceptance script rejects unknown options before starting a server', () => {
  const run = spawnSync(process.execPath, [script.pathname, '--confirm-live'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});
