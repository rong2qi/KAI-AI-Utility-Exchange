#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExchangeSandbox } from '../src/exchange-sandbox.mjs';
import { createExchangeServer } from '../src/exchange-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) {
  console.error('Usage: node scripts/exchange-sandbox-verify.mjs [--output-dir DIRECTORY]');
  process.exit(2);
}
const outputDirectory = resolve(root, args[1] ?? 'evidence/exchange-entry');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function sourceEvidence() {
  const paths = [fileURLToPath(import.meta.url)];
  const collect = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) collect(path);
      else if (item.isFile()) paths.push(path);
    }
  };
  collect(join(root, 'src'));
  const files = paths.sort().map((path) => ({ path: relative(root, path), sha256: sha256(readFileSync(path)) }));
  return {
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    files, sha256: sha256(JSON.stringify(files)),
  };
}

async function verify() {
  // Synthetic clock and ephemeral account key make acceptance repeatable across hour boundaries.
  let now = '2026-10-07T02:10:00.000Z';
  const key = randomBytes(32).toString('hex');
  const sandbox = createExchangeSandbox({ opaqueKey: key, units: 1, now: () => now });
  const server = createExchangeServer({ runtime: sandbox.runtime });
  const results = [];
  try {
    await server.listen();
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'exchange-acceptance-01' };
    const body = { holding_id: sandbox.fixture.holdingId, input: 'EXCHANGE_PRIVATE_BODY_MARKER' };
    const post = (input = body, changes = {}) => fetch(`${server.address()}/v1/compute`, {
      method: 'POST', headers, body: JSON.stringify(input), ...changes,
    });
    const record = (scenario, passed) => {
      results.push({ scenario, passed });
      assert.equal(passed, true, scenario);
    };
    const unauthorized = await post(body, { headers: { ...headers, authorization: 'Bearer invalid' } });
    record('invalid_key_zero_execution', unauthorized.status === 401 && sandbox.inspect().providerCalls === 0);
    const forbidden = await post({ ...body, provider: 'outside-scope' });
    record('outside_scope_zero_execution', forbidden.status === 403 && sandbox.inspect().providerCalls === 0);
    const first = await post();
    const result = await first.json();
    record('output_and_receipt', first.status === 200 && result.output?.echo === body.input && result.receipt?.holding_id === body.holding_id);
    const retry = await post();
    const replay = await retry.json();
    record('replay_deducts_once', retry.status === 200 && JSON.stringify(replay) === JSON.stringify(result) && sandbox.inspect().providerExecutions === 1);
    const conflict = await post({ ...body, input: 'changed' });
    record('changed_input_conflicts', conflict.status === 409 && (await conflict.json()).code === 'IDEMPOTENCY_CONFLICT');
    const exhausted = await post(body, { headers: { ...headers, 'idempotency-key': 'exchange-acceptance-02' } });
    record('exhausted_zero_extra_execution', exhausted.status === 409 && (await exhausted.json()).code === 'HOLDING_EXHAUSTED' && sandbox.inspect().providerCalls === 1);
    now = '2026-10-07T03:00:00.000Z';
    const expired = await post();
    record('expired_grant_zero_extra_execution', expired.status === 403 && (await expired.json()).code === 'AUTHORIZATION_EXPIRED' && sandbox.inspect().providerCalls === 1);
    const receipt = await fetch(`${server.address()}/v1/receipts/${encodeURIComponent(result.receipt.receipt_id)}`, { headers });
    record('private_receipt_after_expiry', receipt.status === 200 && JSON.stringify(await receipt.json()) === JSON.stringify(result.receipt));
  } catch {
    // Do not serialize request/response/exception objects into evidence.
    results.push({ scenario: 'verification_completed', passed: false });
  } finally {
    await server.close();
  }
  const evidence = {
    schemaVersion: 'kai-exchange-entry-evidence.v1', status: results.every((item) => item.passed) ? 'passed' : 'failed',
    createdAt: new Date().toISOString(), nodeVersion: process.version, source: sourceEvidence(),
    transport: 'http-loopback', externalProviderCalls: 0, fixture: 'synthetic-preauthorized-holding',
    results, counters: sandbox.inspect(),
    boundaries: ['single-process', 'memory-only', 'non-streaming', 'no-real-purchase', 'no-live-provider', 'no-production-deployment'],
  };
  const file = `${process.env.GITHUB_RUN_ID ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}` : `local-${Date.now()}`}.json`;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, file), JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync(join(outputDirectory, 'LATEST.json'), JSON.stringify({ file, status: evidence.status }, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, scenarios: results.length, counters: evidence.counters, externalProviderCalls: 0 }));
  if (evidence.status !== 'passed') process.exitCode = 1;
}
await verify().catch(() => { console.error('EXCHANGE_SANDBOX_VERIFY_FAILED'); process.exitCode = 1; });
