import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryReservationStore } from '../src/reservation-store.mjs';
import { ReservationUsageLedger } from '../src/reservation-usage-ledger.mjs';

const holding = {
  accountId: 'account', holdingId: 'holding', grantId: 'grant', offerId: 'offer',
  resourceScope: { models: ['model'], providers: ['provider'], regions: ['region'] },
  slot: { slotStart: '2026-10-07T01:00:00.000Z', slotEnd: '2026-10-07T02:00:00.000Z', lockDeadline: '2026-10-07T00:55:00.000Z', timeZone: 'UTC' },
  unitsRemaining: 2, status: 'active',
};
const success = { status: 'succeeded', providerRequestId: 'provider-request', output: 'private-output', usage: { inputUnits: 1, outputUnits: 2, totalUnits: 3 } };
function setup(units = 2) {
  const store = new MemoryReservationStore({ holdings: [{ ...holding, unitsRemaining: units }] });
  const calls = { provider: 0, receipts: 0 };
  const receipts = new Map();
  const command = {
    accountId: 'account', keyId: 'key', grantId: 'grant', holdingId: 'holding', offerId: 'offer',
    model: 'model', provider: 'provider', region: 'region', at: '2026-10-07T01:10:00.000Z',
    idempotencyKey: 'request-01', requestHash: 'sha256-request-01', providerInput: 'private-input', requestId: 'transport-1',
    providerAdapter: { execute: async () => { calls.provider++; return structuredClone(success); } },
    receiptWriter: { append: async (receipt) => {
      if (receipts.has(receipt.idempotencyKey)) return receipts.get(receipt.idempotencyKey);
      calls.receipts++; receipts.set(receipt.idempotencyKey, receipt); return receipt;
    } },
    buildReceipt: ({ providerResult, holding: settled }) => ({
      receiptId: 'receipt', accountId: 'account', idempotencyKey: 'request-01', requestHash: 'sha256-request-01',
      holdingId: settled.holdingId, keyId: 'key', grantId: 'grant', offerId: 'offer', hourKeyStatus: 'packaged',
      resource: { model: 'model', provider: 'provider', region: 'region' }, slot: holding.slot,
      createdAt: '2026-10-07T01:10:00.000Z', sourceUrl: 'https://kai.com/offers/offer',
      usage: providerResult.usage, status: 'succeeded',
    }),
  };
  return { store, command, calls };
}

test('atomic reservation commits one unit and replays across ledger instances without invoking legacy consume', async () => {
  const s = setup(1);
  const result = await new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command);
  assert.equal(result.output, 'private-output');
  assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 1, available: 0, reserved: 0, committed: 1 });
  const repeated = await new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command);
  assert.deepEqual(repeated, result);
  assert.deepEqual(s.calls, { provider: 1, receipts: 1 });
});

test('two ledger instances sharing a store claim the same request only once', async () => {
  const s = setup();
  let entered; let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  s.command.providerAdapter.execute = async () => { s.calls.provider++; entered(); await pending; return success; };
  const first = new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command);
  await started;
  await assert.rejects(new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command), /EXECUTION_IN_PROGRESS/);
  assert.equal(s.calls.provider, 1);
  finish();
  await first;
  assert.equal((await s.store.inspect('account', 'holding')).committed, 1);
});

test('distinct requests overlap while short reservation transactions preserve the balance', async (t) => {
  const s = setup();
  let release; let entered; let active = 0; let peak = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const bothStarted = new Promise((resolve) => { entered = resolve; });
  s.command.providerAdapter.execute = async () => {
    active++; peak = Math.max(peak, active); if (active === 2) entered();
    await gate; active--; return success;
  };
  const first = new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command);
  const second = new ReservationUsageLedger({ store: s.store }).executeWithResult({ ...s.command, idempotencyKey: 'request-02', requestHash: 'sha256-request-02', buildReceipt: (facts) => ({ ...s.command.buildReceipt(facts), idempotencyKey: 'request-02', requestHash: 'sha256-request-02' }) });
  let timer;
  try { await Promise.race([bothStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NO_ACTUAL_OVERLAP')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(peak, 2);
  assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 2, available: 0, reserved: 2, committed: 0 });
  release(); await Promise.all([first, second]);
  assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 2, available: 0, reserved: 0, committed: 2 });
});

test('local rejection before dispatch releases reservation, including recheck after dispatch marker', async () => {
  for (const failAt of [1, 2]) {
    const s = setup(1); let checks = 0;
    s.command.beforeProviderExecution = async () => { if (++checks === failAt) throw new Error('LOCAL_AUTHORIZATION_DENIED'); };
    await assert.rejects(new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command), /LOCAL_AUTHORIZATION_DENIED/);
    assert.deepEqual(await s.store.inspect('account', 'holding'), { total: 1, available: 1, reserved: 0, committed: 0 });
    assert.equal(s.calls.provider, 0);
    await assert.rejects(new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command), /EXECUTION_RELEASED/);
  }
});

test('unknown Provider outcomes retain quota and never automatically redispatch, including reconstructed state', async () => {
  for (const response of [undefined, { ...success, status: 'failed' }, { ...success, usage: { inputUnits: -1, outputUnits: 0, totalUnits: 0 } }]) {
    const s = setup(1);
    s.command.providerAdapter.execute = async () => { s.calls.provider++; if (response === undefined) throw new Error('private-upstream-error'); return response; };
    await assert.rejects(new ReservationUsageLedger({ store: s.store }).executeWithResult(s.command), /EXECUTION_UNCERTAIN/);
    const restored = new MemoryReservationStore({ snapshot: s.store.snapshot() });
    await assert.rejects(new ReservationUsageLedger({ store: restored }).executeWithResult(s.command), /EXECUTION_UNCERTAIN/);
    assert.deepEqual(await restored.inspect('account', 'holding'), { total: 1, available: 0, reserved: 1, committed: 0 });
    assert.deepEqual(s.calls, { provider: 1, receipts: 0 });
  }
});

test('recorded success resumes after commit or Receipt failure without redispatch or double debit', async () => {
  for (const failure of ['commit', 'receipt']) {
    const s = setup(1); let failOnce = true;
    const store = { reserve: (...args) => s.store.reserve(...args), move: async (command) => {
      if (failure === 'commit' && command.to === 'committed' && failOnce) { failOnce = false; throw new Error('STORE_DOWN'); }
      return s.store.move(command);
    } };
    const append = s.command.receiptWriter.append;
    s.command.receiptWriter.append = async (receipt) => {
      if (failure === 'receipt' && failOnce) { failOnce = false; throw new Error('WRITER_DOWN'); }
      return append(receipt);
    };
    await assert.rejects(new ReservationUsageLedger({ store }).execute(s.command), /EXECUTION_LEDGER_FAILED|RECEIPT_WRITE_FAILED/);
    const restored = new MemoryReservationStore({ snapshot: s.store.snapshot() });
    const result = await new ReservationUsageLedger({ store: restored }).executeWithResult(s.command);
    assert.equal(result.output, 'private-output');
    assert.deepEqual(await restored.inspect('account', 'holding'), { total: 1, available: 0, reserved: 0, committed: 1 });
    assert.deepEqual(s.calls, { provider: 1, receipts: 1 });
  }
});

test('success lost before recording leaves a dispatch marker that prevents a second Provider call', async () => {
  const s = setup(1);
  const store = { reserve: (...args) => s.store.reserve(...args), move: async (command) => {
    if (command.to === 'provider_succeeded') throw new Error('RESULT_STORE_DOWN');
    return s.store.move(command);
  } };
  await assert.rejects(new ReservationUsageLedger({ store }).execute(s.command), /EXECUTION_UNCERTAIN/);
  const restored = new MemoryReservationStore({ snapshot: s.store.snapshot() });
  await assert.rejects(new ReservationUsageLedger({ store: restored }).execute(s.command), /EXECUTION_IN_PROGRESS/);
  assert.equal(s.calls.provider, 1);
  assert.deepEqual(await restored.inspect('account', 'holding'), { total: 1, available: 0, reserved: 1, committed: 0 });
});

test('invalid Receipt candidates are rejected before the external writer sees them', async () => {
  const s = setup(1);
  const build = s.command.buildReceipt;
  s.command.buildReceipt = (facts) => ({ ...build(facts), accountId: 'foreign-account' });
  await assert.rejects(new ReservationUsageLedger({ store: s.store }).execute(s.command), /EXECUTION_LEDGER_FAILED/);
  assert.equal(s.calls.receipts, 0);
  assert.equal(s.calls.provider, 1);
});

test('lost acknowledgements after persisted transitions cannot cause redispatch or a second debit', async () => {
  for (const phase of ['dispatching', 'provider_succeeded', 'committed', 'receipt_prepared', 'receipt_committed']) {
    const s = setup(1); let failOnce = true;
    const store = { reserve: (...args) => s.store.reserve(...args), move: async (command) => {
      const result = await s.store.move(command);
      if (command.to === phase && failOnce) { failOnce = false; throw new Error('ACK_LOST_AFTER_COMMIT'); }
      return result;
    } };
    await assert.rejects(new ReservationUsageLedger({ store }).execute(s.command), /EXECUTION_UNCERTAIN|EXECUTION_LEDGER_FAILED/);
    const restored = new MemoryReservationStore({ snapshot: s.store.snapshot() });
    if (phase === 'dispatching') {
      await assert.rejects(new ReservationUsageLedger({ store: restored }).execute(s.command), /EXECUTION_IN_PROGRESS/);
      assert.deepEqual(s.calls, { provider: 0, receipts: 0 });
      assert.deepEqual(await restored.inspect('account', 'holding'), { total: 1, available: 0, reserved: 1, committed: 0 });
    } else {
      assert.equal((await new ReservationUsageLedger({ store: restored }).executeWithResult(s.command)).output, 'private-output');
      assert.deepEqual(s.calls, { provider: 1, receipts: 1 });
      assert.deepEqual(await restored.inspect('account', 'holding'), { total: 1, available: 0, reserved: 0, committed: 1 });
    }
  }
});
