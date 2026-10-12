import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryReservationStore } from '../src/reservation-store.mjs';
import { SettlementRecovery } from '../src/settlement-recovery.mjs';
import { holding, success, reservation } from './support/sqlite-reservation-fixture.mjs';

function fixture(store = new MemoryReservationStore({ holdings: [holding] })) {
  let now = '2026-10-09T08:01:00.000Z';
  const verified = { key: { keyId: 'key', accountId: 'account', grantIds: ['grant'], issuedAt: holding.slot.slotStart,
    expiresAt: holding.slot.slotEnd, receiptUntil: '2026-10-10T08:00:00.000Z' },
  grants: [{ grantId: 'grant', accountId: 'account', issuedAt: holding.slot.slotStart, expiresAt: holding.slot.slotEnd,
    receiptUntil: '2026-10-10T08:00:00.000Z', resourceScope: holding.resourceScope, capabilityScope: ['usage.recover'] }] };
  const receipts = new Map();
  const receiptWriter = store.receiptWriter ?? { append: async (r) => {
    const old = receipts.get(r.idempotencyKey); if (old) { assert.deepEqual(r, old); return old; }
    receipts.set(r.idempotencyKey, structuredClone(r)); return r;
  } };
  const keyVerifier = { verify: async (key) => { if (key !== 'local-test-key') throw Error('private secret'); return structuredClone(verified); } };
  const recovery = new SettlementRecovery({ store, receiptWriter, keyVerifier, clock: { now: () => now } });
  return { store, recovery, verified, keyVerifier, receiptWriter, setNow: (value) => { now = value; },
    request: { opaqueKey: 'local-test-key', idempotencyKey: 'operation-one' } };
}
async function seed(store, phase = 'provider_succeeded') {
  const command = reservation();
  await store.reserve(command);
  if (phase === 'reserved') return;
  await store.move({ ...command, from: 'reserved', to: 'dispatching' });
  if (phase === 'dispatching') return;
  await store.move({ ...command, from: 'dispatching', to: phase, ...(phase === 'provider_succeeded' ? { providerResult: success } : {}) });
}

test('after expiry, recovery settles only the stored success and preserves the original identity', async () => {
  const s = fixture(); await seed(s.store);
  const first = await s.recovery.recover(s.request);
  assert.equal(first.status, 'settled'); assert.equal(first.output, success.output);
  assert.equal(first.receipt.createdAt, reservation().at);
  assert.equal(first.receipt.keyId, 'key');
  assert.deepEqual(await s.recovery.recover(s.request), first);
  assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 2, available: 1, reserved: 0, committed: 1 });
});

test('unknown, unfinished and released work never creates success or releases uncertain quota', async () => {
  for (const phase of ['reserved', 'dispatching', 'uncertain', 'released']) {
    const s = fixture(); await seed(s.store, phase);
    const before = s.store.snapshot();
    const result = await s.recovery.recover(s.request);
    assert.equal(result.status, phase === 'released' ? 'released' : 'pending_reconciliation');
    assert.equal(Object.hasOwn(result, 'output'), false);
    assert.deepEqual(s.store.snapshot(), before);
  }
  const s = fixture();
  assert.deepEqual(await s.recovery.recover(s.request), { status: 'error', code: 'EXECUTION_NOT_FOUND' });
  assert.equal(s.store.snapshot().entries.length, 0);
});

test('recovery authorizes the original account, key, grant, capability, scope and readback lifetime', async () => {
  const changes = [
    (v) => { v.key.accountId = 'foreign'; v.grants[0].accountId = 'foreign'; },
    (v) => { v.key.keyId = 'other-key'; },
    (v) => { v.key.grantIds = ['other-grant']; v.grants[0].grantId = 'other-grant'; },
    (v) => { v.grants[0].capabilityScope = ['compute', 'usage.receipt']; },
    (v) => { v.grants[0].revokedAt = '2026-10-09T08:00:00Z'; },
    (v) => { v.grants[0].resourceScope = { ...holding.resourceScope, models: ['other-model'] }; },
    (v) => { v.key.receiptUntil = holding.slot.slotEnd; },
    (v) => { v.grants[0].receiptUntil = holding.slot.slotEnd; },
    (v) => { v.key.issuedAt = '2026-10-10T07:00:00Z'; },
    (v) => { v.grants[0].issuedAt = '2026-10-10T07:00:00Z'; },
    (v) => { v.grants[0].revokedAt = 'invalid'; },
  ];
  for (const change of changes) {
    const s = fixture(); await seed(s.store); change(s.verified);
    const before = s.store.snapshot(); const result = await s.recovery.recover(s.request);
    assert.equal(result.status, 'error'); assert.equal(Object.hasOwn(result, 'output'), false);
    assert.deepEqual(s.store.snapshot(), before);
  }
});

test('authorization is refreshed after storage I/O and before settlement writes', async () => {
  for (const point of ['read', 'commit']) {
    const s = fixture(); await seed(s.store);
    const target = point === 'read' ? 'getReservation' : 'move';
    const original = s.store[target].bind(s.store);
    s.store[target] = async (...args) => { const value = await original(...args); s.setNow('2026-10-10T08:00:00Z'); return value; };
    assert.deepEqual(await s.recovery.recover(s.request), { status: 'error', code: 'AUTHORIZATION_EXPIRED' });
    assert.equal(s.store.snapshot().entries[0].state, point === 'read' ? 'provider_succeeded' : 'committed');
  }
});

test('recovery rejects client facts and never leaks verification exceptions', async () => {
  const s = fixture(); await seed(s.store);
  for (const field of ['input', 'provider', 'accountId', 'usage', 'providerResult', 'at', 'force']) {
    assert.deepEqual(await s.recovery.recover({ ...s.request, [field]: 'injected' }), { status: 'error', code: 'REQUEST_INVALID' });
  }
  assert.deepEqual(await s.recovery.recover({ ...s.request, opaqueKey: 'wrong' }), { status: 'error', code: 'KEY_INVALID' });
  assert.equal(s.store.snapshot().entries[0].state, 'provider_succeeded');
});

test('HTTP recovery after expiry is separate from new Compute and rejects supplied outcomes', async (t) => {
  const { createExchangeSandbox } = await import('../src/exchange-sandbox.mjs');
  const { createExchangeServer } = await import('../src/exchange-http.mjs');
  let now = '2026-10-09T07:10:00Z';
  const sandbox = createExchangeSandbox({ opaqueKey: 'local-test-key', now: () => now });
  const server = createExchangeServer({ runtime: sandbox.runtime, recovery: sandbox.recovery });
  await server.listen(); t.after(() => server.close());
  const headers = { authorization: 'Bearer local-test-key', 'content-type': 'application/json', 'idempotency-key': 'operation-one' };
  const post = (path, body) => fetch(server.address() + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const compute = { holding_id: sandbox.fixture.holdingId, input: 'private synthetic input' };
  const first = await post('/v1/compute', compute); assert.equal(first.status, 200); const result = await first.json();
  now = '2026-10-09T08:01:00Z';
  const recovered = await post('/v1/settlements/recover', { idempotency_key: 'operation-one' });
  assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { status: 'settled', ...result });
  const rejected = await post('/v1/compute', compute); assert.equal(rejected.status, 403);
  for (const extra of [{ input: 'new work' }, { providerResult: success }, { account_id: 'foreign' }]) {
    const r = await post('/v1/settlements/recover', { idempotency_key: 'operation-one', ...extra }); assert.equal(r.status, 400);
  }
  assert.equal((await post('/v1/settlements/recover', { idempotency_key: 'unknown-request' })).status, 404);
  assert.equal(sandbox.inspect().providerCalls, 1);
});

test('SQLite recovery survives every known-success checkpoint and concurrent recoveries deduct only once', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteReservationStore } = await import('../src/adapters/sqlite-reservation-store.mjs');
  const { buildReservationReceipt } = await import('../src/reservation-settlement.mjs');
  for (const phase of ['provider_succeeded', 'committed', 'receipt_prepared', 'receipt_written', 'receipt_committed']) {
    const directory = mkdtempSync(join(tmpdir(), 'kai-recovery-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
    const path = join(directory, 'usage.sqlite');
    const store = new SqliteReservationStore({ path, holdings: [holding] });
    await seed(store);
    const command = reservation();
    let expected;
    if (phase !== 'provider_succeeded') {
      const entry = await store.move({ ...command, from: 'provider_succeeded', to: 'committed' });
      expected = buildReservationReceipt(entry);
      if (phase !== 'committed') {
        await store.move({ ...command, from: 'committed', to: 'receipt_prepared', receipt: expected });
        if (phase !== 'receipt_prepared') {
          await store.receiptWriter.append(expected);
          if (phase === 'receipt_committed') await store.move({ ...command, from: 'receipt_prepared', to: 'receipt_committed', receipt: expected });
        }
      }
    }
    store.close();
    const a = new SqliteReservationStore({ path }); const b = new SqliteReservationStore({ path });
    t.after(() => { a.close(); b.close(); });
    // Recovery must never acquire a new claim, regardless of durable phase.
    a.reserve = b.reserve = () => { throw Error('RECOVERY_MUST_NOT_RESERVE'); };
    const sa = fixture(a); const sb = fixture(b);
    const results = await Promise.all([sa.recovery.recover(sa.request), sb.recovery.recover(sb.request)]);
    assert.equal(results[0].status, 'settled'); assert.deepEqual(results[1], results[0]);
    if (expected) assert.deepEqual(results[0].receipt, expected);
    assert.deepEqual(await a.inspect('account', 'holding'), { total: 2, available: 1, reserved: 0, committed: 1 });
    assert.deepEqual(await b.receiptWriter.get('account', results[0].receipt.receiptId), results[0].receipt);
  }
});

test('lost settlement acknowledgements can resume while corrupt durable Receipts fail closed', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteReservationStore } = await import('../src/adapters/sqlite-reservation-store.mjs');
  for (const stage of ['committed', 'receipt_prepared', 'receipt_committed', 'writer']) {
    const directory = mkdtempSync(join(tmpdir(), 'kai-recovery-ack-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
    const store = new SqliteReservationStore({ path: join(directory, 'usage.sqlite'), holdings: [holding] });
    t.after(() => store.close()); await seed(store);
    const s = fixture(store); const move = store.move.bind(store); const append = s.receiptWriter.append;
    store.move = async (command) => { const result = await move(command); if (command.to === stage) throw Error('ACK_LOST'); return result; };
    s.receiptWriter.append = async (receipt) => { const result = await append(receipt); if (stage === 'writer') throw Error('ACK_LOST'); return result; };
    assert.equal((await s.recovery.recover(s.request)).status, 'error');
    store.move = move; s.receiptWriter.append = append;
    assert.equal((await s.recovery.recover(s.request)).status, 'settled');
    assert.equal((await store.inspect('account', 'holding')).committed, 1);
    const db = new DatabaseSync(join(directory, 'usage.sqlite')); db.exec('DELETE FROM receipts'); db.close();
    assert.deepEqual(await s.recovery.recover(s.request), { status: 'error', code: 'EXECUTION_LEDGER_FAILED' });
  }
});

test('HTTP recovery reports pending work without internals and treats malformed UTF-8 as client input', async (t) => {
  const { createExchangeServer } = await import('../src/exchange-http.mjs');
  const s = fixture(); await seed(s.store, 'uncertain');
  const server = createExchangeServer({ runtime: { handle: () => { throw Error('MUST_NOT_USE_COMPUTE'); } }, recovery: s.recovery });
  await server.listen(); t.after(() => server.close());
  const headers = { authorization: 'Bearer local-test-key', 'content-type': 'application/json' };
  const pending = await fetch(server.address() + '/v1/settlements/recover', { method: 'POST', headers, body: JSON.stringify({ idempotency_key: 'operation-one' }) });
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: 'pending_reconciliation', reason: 'PROVIDER_OUTCOME_NOT_RECORDED' });
  const bad = await fetch(server.address() + '/v1/settlements/recover', { method: 'POST', headers, body: Buffer.from([0xff]) });
  assert.equal(bad.status, 400);
});

test('Compute retry after lost commit acknowledgement preserves admission time through cross-hour recovery', async () => {
  const { createExchangeSandbox } = await import('../src/exchange-sandbox.mjs');
  let now = '2026-10-09T07:10:00.000Z';
  const sandbox = createExchangeSandbox({ opaqueKey: 'local-test-key', now: () => now });
  const store = sandbox.runtime.usageLedger.store;
  const move = store.move.bind(store); let lost = false;
  store.move = async (c) => { const e = await move(c); if (c.to === 'committed' && !lost) { lost = true; throw Error('ACK_LOST'); } return e; };
  const command = { requestId: 'request', opaqueKey: 'local-test-key', userText: '执行计算', holdingId: sandbox.fixture.holdingId,
    idempotencyKey: 'operation-one', providerInput: 'synthetic input' };
  assert.equal((await sandbox.runtime.handle(command)).kind, 'error');
  now = '2026-10-09T07:11:00.000Z';
  const replay = await sandbox.runtime.handle(command); assert.equal(replay.kind, 'receipt');
  now = '2026-10-09T08:01:00.000Z';
  const recovered = await sandbox.recovery.recover({ opaqueKey: 'local-test-key', idempotencyKey: command.idempotencyKey });
  assert.equal(recovered.status, 'settled');
  assert.equal(recovered.receipt.createdAt, '2026-10-09T07:10:00.000Z');
  assert.deepEqual(recovered.receipt, replay.receipt);
  assert.equal(sandbox.inspect().providerCalls, 1);
});
