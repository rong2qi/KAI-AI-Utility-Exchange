import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteReservationStore } from '../src/adapters/sqlite-reservation-store.mjs';
import { ReservationUsageLedger } from '../src/reservation-usage-ledger.mjs';
import { createExchangeSandbox } from '../src/exchange-sandbox.mjs';
import { createExchangeServer } from '../src/exchange-http.mjs';
import { holding, success, reservation, execution } from './support/sqlite-reservation-fixture.mjs';

function database(t, units = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'kai-reservation-'));
  const path = join(directory, 'usage.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = (create = false) => {
    const store = new SqliteReservationStore({ path, ...(create ? { holdings: [{ ...holding, unitsRemaining: units }] } : {}) });
    stores.push(store); return store;
  };
  return { directory, path, open, store: open(true) };
}

test('SQLite persists claims, results, debit and private Receipt across independent connections', async (t) => {
  const s = database(t, 1); let calls = 0;
  const command = execution(s.store, async () => { calls++; return success; });
  const first = await new ReservationUsageLedger({ store: s.store }).executeWithResult(command);
  s.store.close();
  const reopened = s.open();
  const replay = await new ReservationUsageLedger({ store: reopened }).executeWithResult(execution(reopened, async () => { calls++; return success; }));
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.deepEqual(await reopened.inspect('account', 'holding'), { total: 1, available: 0, reserved: 0, committed: 1 });
  assert.deepEqual(await reopened.receiptWriter.get('account', first.receipt.receiptId), first.receipt);
  assert.equal(await reopened.receiptWriter.get('foreign', first.receipt.receiptId), undefined);
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
});

test('reopening never reseeds balance and a rejected transition leaves durable facts unchanged', async (t) => {
  const s = database(t, 1);
  const command = reservation();
  await s.store.reserve(command);
  assert.throws(() => new SqliteReservationStore({ path: s.path, holdings: [holding] }), /DATABASE_EXISTS/);
  await assert.rejects(s.store.move({ ...command, from: 'reserved', to: 'dispatching', ownerToken: 'foreign' }), /RESERVATION_CONFLICT/);
  const reopened = s.open();
  assert.equal((await reopened.reserve({ ...command, ownerToken: 'second-owner' })).acquired, false);
  assert.deepEqual(await reopened.inspect('account', 'holding'), { total: 1, available: 0, reserved: 1, committed: 0 });
});

function worker(t, args) {
  const child = fork(new URL('./support/sqlite-reservation-worker.mjs', import.meta.url), args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let output = ''; child.stderr.on('data', (data) => { output += data; });
  const queue = []; const waiters = [];
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`WORKER_EXIT:${code}:${signal}:${output}`));
    resolve({ code, signal });
  }));
  child.on('message', (message) => { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else queue.push(message); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, next, exited };
}

test('independent processes claim one operation once and cannot overspend the final unit', { timeout: 15000 }, async (t) => {
  for (const same of [true, false]) {
    const s = database(t, 1);
    const workers = [1, 2, 3].map((i) => worker(t, [s.path, 'reserve', same ? 'same-operation' : `operation-${i}`]));
    await Promise.all(workers.map(async (w) => assert.equal((await w.next()).kind, 'ready')));
    for (const w of workers) w.child.send('go');
    const results = await Promise.all(workers.map((w) => w.next()));
    assert.equal(results.filter((r) => r.acquired).length, 1);
    if (same) assert.equal(results.filter((r) => r.acquired === false).length, 2);
    else assert.equal(results.filter((r) => r.error === 'HOLDING_EXHAUSTED').length, 2);
    await Promise.all(workers.map((w) => w.exited));
    assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 1, available: 0, reserved: 1, committed: 0 });
  }
});

test('SIGKILL before SQL commit rolls back partial writes and releases the database lock', { timeout: 10000 }, async (t) => {
  const s = database(t, 1);
  const w = worker(t, [s.path, 'uncommitted', 'operation-one']);
  await w.next(); w.child.send('go');
  assert.equal((await w.next()).kind, 'checkpoint');
  w.child.kill('SIGKILL'); assert.equal((await w.exited).signal, 'SIGKILL');
  assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 1, available: 1, reserved: 0, committed: 0 });
  assert.equal((await s.store.reserve(reservation())).acquired, true);
});

test('a failed aggregate write atomically rolls back the execution claim as well', async (t) => {
  const s = database(t, 1);
  const db = new DatabaseSync(s.path); t.after(() => db.close());
  db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON holdings BEGIN SELECT RAISE(ABORT, 'INJECTED_WRITE_FAILURE'); END");
  await assert.rejects(s.store.reserve(reservation()), /INJECTED_WRITE_FAILURE/);
  assert.equal(db.prepare('SELECT count(*) n FROM claims').get().n, 0);
  db.exec('DROP TRIGGER deny_update');
  assert.equal((await s.store.reserve(reservation())).acquired, true);
});

test('after SIGKILL, recorded success resumes without another Provider call or debit; unknown work stays held', { timeout: 20000 }, async (t) => {
  for (const phase of ['reserved', 'dispatching', 'provider_return', 'uncertain', 'provider_succeeded', 'committed', 'receipt_prepared', 'receipt_written', 'receipt_committed']) {
    const s = database(t, 1); const trace = join(s.directory, 'calls.log');
    const w = worker(t, [s.path, 'execute', 'operation-one', phase, trace]);
    await w.next(); w.child.send('go');
    assert.equal((await w.next()).kind, 'checkpoint', phase);
    w.child.kill('SIGKILL'); assert.equal((await w.exited).signal, 'SIGKILL');
    const recovery = worker(t, [s.path, 'execute', 'operation-one', 'none', trace]);
    await recovery.next(); recovery.child.send('go');
    const result = await recovery.next(); await recovery.exited;
    const unknown = ['reserved', 'dispatching', 'provider_return', 'uncertain'].includes(phase);
    if (unknown) assert.equal(result.error, phase === 'uncertain' ? 'EXECUTION_UNCERTAIN' : 'EXECUTION_IN_PROGRESS', phase);
    else assert.equal(result.receiptId, 'receipt-operation-one', phase);
    const calls = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').length : 0;
    assert.equal(calls, ['reserved', 'dispatching'].includes(phase) ? 0 : 1, phase);
    assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 1, available: 0, reserved: unknown ? 1 : 0, committed: unknown ? 0 : 1 });
    const db = new DatabaseSync(s.path);
    assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n, unknown ? 0 : 1); db.close();
  }
});

test('database files fail closed for public permissions, symlinks, unknown schema and loss-prone JSON', async (t) => {
  const s = database(t);
  chmodSync(s.path, 0o644);
  assert.throws(() => s.open(), /DATABASE_FILE_NOT_PRIVATE/);
  chmodSync(s.path, 0o600);
  const alias = join(s.directory, 'alias.sqlite'); symlinkSync(s.path, alias);
  assert.throws(() => new SqliteReservationStore({ path: alias }), /DATABASE_FILE_NOT_PRIVATE/);
  const unknown = join(s.directory, 'unknown.sqlite'); writeFileSync(unknown, '', { mode: 0o600 });
  assert.throws(() => new SqliteReservationStore({ path: unknown }), /DATABASE_SCHEMA_UNSUPPORTED/);
  const claim = reservation(); await s.store.reserve(claim);
  await s.store.move({ ...claim, from: 'reserved', to: 'dispatching' });
  await assert.rejects(s.store.move({ ...claim, from: 'dispatching', to: 'provider_succeeded', providerResult: { ...success, output: { missing: undefined } } }), /RESERVATION_JSON_LOSS/);
  assert.equal((await s.store.reserve(claim)).entry.state, 'dispatching');
});

test('SQL Receipt writer rejects unprepared or changed data, keeps account isolation and requires durable completion', async (t) => {
  const s = database(t);
  const command = execution(s.store, async () => success);
  const candidate = command.buildReceipt({ providerResult: success });
  await assert.rejects(s.store.receiptWriter.append(candidate), /RECEIPT_NOT_PREPARED/);
  const claim = reservation(); await s.store.reserve(claim);
  await s.store.move({ ...claim, from: 'reserved', to: 'dispatching' });
  await s.store.move({ ...claim, from: 'dispatching', to: 'provider_succeeded', providerResult: success });
  await s.store.move({ ...claim, from: 'provider_succeeded', to: 'committed' });
  await s.store.move({ ...claim, from: 'committed', to: 'receipt_prepared', receipt: candidate });
  await assert.rejects(s.store.move({ ...claim, from: 'receipt_prepared', to: 'receipt_committed', receipt: candidate }), /RECEIPT_NOT_PERSISTED/);
  await assert.rejects(s.store.receiptWriter.append({ ...candidate, usage: { inputUnits: 9, outputUnits: 0, totalUnits: 9 } }), /IDEMPOTENCY_CONFLICT/);
  await s.store.receiptWriter.append(candidate);
  await s.store.receiptWriter.append(Object.fromEntries(Object.entries(candidate).reverse()));
  await s.store.move({ ...claim, from: 'receipt_prepared', to: 'receipt_committed', receipt: candidate });
  assert.equal(await s.store.getHolding('other-account', 'holding'), undefined);
  assert.equal(await s.store.receiptWriter.get('other-account', candidate.receiptId), undefined);
  const db = new DatabaseSync(s.path); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  // Deliberate corrupt rows are detected at the read boundary.
  db.prepare('UPDATE receipts SET receipt_json=?').run(JSON.stringify({ ...candidate, accountId: 'other-account' }));
  await assert.rejects(s.store.receiptWriter.get('account', candidate.receiptId), /RESERVATION_INVALID/);
});

test('database write contention fails within a bound and does not create a partial claim', async (t) => {
  const s = database(t); const blocked = new SqliteReservationStore({ path: s.path, busyTimeoutMs: 5 });
  t.after(() => blocked.close());
  const db = new DatabaseSync(s.path); t.after(() => db.close());
  db.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(blocked.reserve(reservation()), /locked/); }
  finally { db.exec('ROLLBACK'); }
  assert.equal((await blocked.reserve(reservation())).acquired, true);
  db.exec('DELETE FROM claims');
  await assert.rejects(blocked.inspect('account', 'holding'), /RESERVATION_INVALID/);
});

test('missing or corrupted durable Receipts cannot be hidden by replaying a completed aggregate', async (t) => {
  for (const alteration of ['delete', 'change']) {
    const s = database(t, 1);
    await new ReservationUsageLedger({ store: s.store }).execute(execution(s.store, async () => success));
    const db = new DatabaseSync(s.path); t.after(() => db.close());
    if (alteration === 'delete') db.exec('DELETE FROM receipts');
    else db.exec("UPDATE receipts SET receipt_json=json_set(receipt_json, '$.receiptId', 'corrupted')");
    let calls = 0;
    await assert.rejects(new ReservationUsageLedger({ store: s.store }).execute(execution(s.store, async () => { calls++; return success; })), /RESERVATION_INVALID/);
    assert.equal(calls, 0);
  }
});

test('Exchange HTTP can reuse SQL ports after Runtime reconstruction with identical output and one debit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'kai-exchange-sql-'));
  const path = join(directory, 'usage.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let providerCalls = 0;
  const compose = async (create) => {
    const sandbox = createExchangeSandbox({ opaqueKey: 'sql-test-account-key', now: () => '2026-10-09T07:10:00.000Z', units: 1 });
    const initial = await sandbox.runtime.holdingPort.get(sandbox.fixture.accountId, sandbox.fixture.holdingId);
    const store = new SqliteReservationStore({ path, ...(create ? { holdings: [initial] } : {}) });
    sandbox.runtime.holdingPort = { get: (...args) => store.getHolding(...args) };
    sandbox.runtime.usageLedger = new ReservationUsageLedger({ store });
    sandbox.runtime.receiptWriter = store.receiptWriter;
    const provider = sandbox.runtime.providerAdapters.get(sandbox.fixture.provider);
    const execute = provider.execute.bind(provider);
    provider.execute = async (request) => { providerCalls++; return execute(request); };
    const server = createExchangeServer({ runtime: sandbox.runtime });
    await server.listen();
    return { server, store, fixture: sandbox.fixture };
  };
  const request = async (s) => {
    const response = await fetch(`${s.server.address()}/v1/compute`, { method: 'POST',
      headers: { authorization: 'Bearer sql-test-account-key', 'content-type': 'application/json', 'idempotency-key': 'sql-http-operation' },
      body: JSON.stringify({ holding_id: s.fixture.holdingId, input: 'synthetic-private-input' }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  let first;
  const one = await compose(true);
  try { first = await request(one); } finally { await one.server.close(); one.store.close(); }
  const two = await compose(false);
  try {
    assert.deepEqual(await request(two), first);
    assert.equal(providerCalls, 1);
    assert.deepEqual(await two.store.inspect(two.fixture.accountId, two.fixture.holdingId), { total: 1, available: 0, reserved: 0, committed: 1 });
  } finally { await two.server.close(); two.store.close(); }
});
