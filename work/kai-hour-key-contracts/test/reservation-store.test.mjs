import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryReservationStore } from '../src/reservation-store.mjs';

const at = '2026-10-07T06:10:00.000Z';
const holding = {
  holdingId: 'holding-a', accountId: 'account-a', grantId: 'grant-a', offerId: 'offer-a',
  resourceScope: { models: ['model-a'], providers: ['sandbox'], regions: ['local'] },
  slot: { slotStart: '2026-10-07T06:00:00.000Z', lockDeadline: '2026-10-07T05:55:00.000Z', slotEnd: '2026-10-07T07:00:00.000Z', timeZone: 'Asia/Shanghai' },
  unitsRemaining: 2, status: 'active',
};
const reserve = (idempotencyKey = 'operation-a', overrides = {}) => ({
  accountId: holding.accountId, idempotencyKey, requestHash: 'request-hash-a',
  binding: { keyId: 'key-a', grantId: holding.grantId, holdingId: holding.holdingId, offerId: holding.offerId, model: 'model-a', provider: 'sandbox', region: 'local' },
  units: 1, at, ownerToken: 'owner-a', ...overrides,
});
const move = (from, to, overrides = {}) => ({
  accountId: holding.accountId, idempotencyKey: 'operation-a', ownerToken: 'owner-a', from, to, ...overrides,
});
const providerResult = {
  providerRequestId: 'provider-a', output: { answer: 'sandbox answer' },
  usage: { inputUnits: 4, outputUnits: 2, totalUnits: 6 }, status: 'succeeded',
};
const receipt = {
  receiptId: 'receipt-a', accountId: holding.accountId, keyId: 'key-a', grantId: holding.grantId,
  holdingId: holding.holdingId, offerId: holding.offerId, idempotencyKey: 'operation-a', hourKeyStatus: 'packaged',
  resource: { model: 'model-a', provider: 'sandbox', region: 'local' }, slot: holding.slot,
  requestHash: 'request-hash-a', usage: providerResult.usage, status: 'succeeded',
  createdAt: at, sourceUrl: 'https://kai.com/offers/offer-a',
};

test('two available units admit two simultaneous reservations and reject a third', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  const results = await Promise.all([store.reserve(reserve()), store.reserve(reserve('operation-b', { ownerToken: 'owner-b' }))]);
  assert.deepEqual(results.map((result) => result.acquired), [true, true]);
  assert.deepEqual(await store.inspect(holding.accountId, holding.holdingId), { total: 2, available: 0, reserved: 2, committed: 0 });
  await assert.rejects(store.reserve(reserve('operation-c')), /HOLDING_EXHAUSTED/);
  assert.equal((await store.getHolding(holding.accountId, holding.holdingId)).unitsRemaining, 2);
});

test('one operation has a single owner even when two callers claim it simultaneously', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  const results = await Promise.all([
    store.reserve(reserve()), store.reserve(reserve('operation-a', { ownerToken: 'owner-b' })),
  ]);
  assert.deepEqual(results.map((result) => result.acquired), [true, false]);
  assert.equal(results[1].entry.ownerToken, 'owner-a');
  await assert.rejects(store.reserve(reserve('operation-a', { requestHash: 'changed' })), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(store.reserve(reserve('operation-a', { binding: { ...reserve().binding, keyId: 'different-key' } })), /IDEMPOTENCY_CONFLICT/);
  assert.equal((await store.inspect(holding.accountId, holding.holdingId)).reserved, 1);
});

test('settlement commits a reserved unit exactly once and preserves a readable receipt', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  await store.move(move('dispatching', 'provider_succeeded', { providerResult }));
  const committed = await store.move(move('provider_succeeded', 'committed'));
  assert.equal(committed.holding.unitsRemaining, 1);
  assert.deepEqual(await store.move(move('provider_succeeded', 'committed')), committed);
  assert.deepEqual(await store.inspect(holding.accountId, holding.holdingId), { total: 2, available: 1, reserved: 0, committed: 1 });
  await store.move(move('committed', 'receipt_prepared', { receipt }));
  const saved = await store.move(move('receipt_prepared', 'receipt_committed', { receipt }));
  const repeated = await store.reserve(reserve('operation-a', { ownerToken: 'owner-c', at: holding.slot.slotEnd }));
  assert.equal(repeated.acquired, false);
  assert.deepEqual(repeated.entry.receipt, receipt);
  assert.deepEqual(await store.move(move('receipt_prepared', 'receipt_committed', { receipt })), saved);
  await assert.rejects(store.move(move('receipt_prepared', 'receipt_committed', { receipt: { ...receipt, requestHash: 'changed' } })), /RESERVATION_CONFLICT/);
});

test('unknown upstream outcomes retain their reservation and cannot be released or reclaimed', async () => {
  const store = new MemoryReservationStore({ holdings: [{ ...holding, unitsRemaining: 1 }] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  await store.move(move('dispatching', 'uncertain'));
  assert.deepEqual(await store.inspect(holding.accountId, holding.holdingId), { total: 1, available: 0, reserved: 1, committed: 0 });
  assert.equal((await store.reserve(reserve('operation-a', { ownerToken: 'owner-b' }))).acquired, false);
  await assert.rejects(store.reserve(reserve('operation-b')), /HOLDING_EXHAUSTED/);
  await assert.rejects(store.move(move('uncertain', 'released')), /RESERVATION_CONFLICT/);
});

test('release restores availability without consuming units and cannot reverse a commit', async () => {
  const store = new MemoryReservationStore({ holdings: [{ ...holding, unitsRemaining: 1 }] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  await store.move(move('dispatching', 'released'));
  assert.deepEqual(await store.inspect(holding.accountId, holding.holdingId), { total: 1, available: 1, reserved: 0, committed: 0 });
  assert.equal((await store.reserve(reserve())).acquired, false);
  await assert.rejects(store.move(move('released', 'reserved')), /RESERVATION_CONFLICT/);
  await store.reserve(reserve('operation-b'));
  assert.equal((await store.inspect(holding.accountId, holding.holdingId)).available, 0);
});

test('only the owner may advance the exact state and successful payloads cannot change', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  await store.reserve(reserve());
  await assert.rejects(store.move(move('reserved', 'dispatching', { ownerToken: 'attacker' })), /RESERVATION_CONFLICT/);
  await assert.rejects(store.move(move('dispatching', 'provider_succeeded', { providerResult })), /RESERVATION_CONFLICT/);
  await assert.rejects(store.move(move('reserved', 'committed')), /RESERVATION_CONFLICT/);
  await store.move(move('reserved', 'dispatching'));
  await assert.rejects(store.move(move('dispatching', 'provider_succeeded', { providerResult: { ...providerResult, usage: { inputUnits: 4, outputUnits: 2, totalUnits: 9 } } })), /RESERVATION_INVALID/);
  await store.move(move('dispatching', 'provider_succeeded', { providerResult }));
  await store.move(move('dispatching', 'provider_succeeded', { providerResult: { ...providerResult, output: { answer: 'sandbox answer' } } }));
  await assert.rejects(store.move(move('dispatching', 'provider_succeeded', { providerResult: { ...providerResult, output: 'changed' } })), /RESERVATION_CONFLICT/);
  await assert.rejects(store.move(move('provider_succeeded', 'dispatching')), /RESERVATION_CONFLICT/);
});

test('reservation admission enforces account, Holding facts, resource, status, and exact hour boundaries', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  for (const change of [
    { accountId: 'another-account' },
    { binding: { ...reserve().binding, holdingId: 'another-holding' } },
    { binding: { ...reserve().binding, grantId: 'another-grant' } },
    { binding: { ...reserve().binding, offerId: 'another-offer' } },
    { binding: { ...reserve().binding, model: 'another-model' } },
  ]) await assert.rejects(store.reserve(reserve('operation-a', change)), /HOLDING_REQUIRED/);
  for (const invalidAt of ['2026-10-07T05:59:59.999Z', holding.slot.slotEnd]) {
    await assert.rejects(store.reserve(reserve('operation-a', { at: invalidAt })), /SLOT_NOT_ACTIVE/);
  }
  await assert.rejects(new MemoryReservationStore({ holdings: [{ ...holding, status: 'revoked' }] }).reserve(reserve()), /HOLDING_REQUIRED/);
  await assert.rejects(store.reserve(reserve('operation-a', { units: 0 })), /RESERVATION_INVALID/);
  await store.reserve(reserve('operation-a', { at: holding.slot.slotStart }));
  assert.equal(await store.getHolding('another-account', holding.holdingId), undefined);
  assert.deepEqual(await store.inspect(holding.accountId, holding.holdingId), { total: 2, available: 1, reserved: 1, committed: 0 });
});

test('fractional Provider usage is separate from integer Holding execution units', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  const normalized = { ...providerResult, usage: { inputUnits: 0.25, outputUnits: 0.5, totalUnits: 0.75 } };
  const result = await store.move(move('dispatching', 'provider_succeeded', { providerResult: normalized }));
  assert.deepEqual(result.providerResult.usage, normalized.usage);
  assert.equal(result.units, 1);
});

test('snapshot restoration preserves reservations and settled results without granting a new execution claim', async () => {
  for (const stopAt of ['reserved', 'dispatching', 'uncertain', 'provider_succeeded', 'committed', 'receipt_prepared', 'receipt_committed', 'released']) {
    const store = new MemoryReservationStore({ holdings: [holding] });
    await store.reserve(reserve());
    if (stopAt === 'released') await store.move(move('reserved', 'released'));
    else if (stopAt !== 'reserved') {
      await store.move(move('reserved', 'dispatching'));
      if (stopAt === 'uncertain') await store.move(move('dispatching', 'uncertain'));
      else if (stopAt !== 'dispatching') {
        await store.move(move('dispatching', 'provider_succeeded', { providerResult }));
        if (stopAt !== 'provider_succeeded') {
          await store.move(move('provider_succeeded', 'committed'));
          if (['receipt_prepared', 'receipt_committed'].includes(stopAt)) await store.move(move('committed', 'receipt_prepared', { receipt }));
          if (stopAt === 'receipt_committed') await store.move(move('receipt_prepared', 'receipt_committed', { receipt }));
        }
      }
    }
    const state = store.snapshot();
    const restored = new MemoryReservationStore({ snapshot: state });
    const repeated = await restored.reserve(reserve('operation-a', { ownerToken: 'restarted-owner' }));
    assert.equal(repeated.acquired, false, stopAt);
    assert.equal(repeated.entry.state, stopAt);
    assert.deepEqual(await restored.inspect(holding.accountId, holding.holdingId), await store.inspect(holding.accountId, holding.holdingId));
    state.holdings[0].unitsRemaining = 1_000;
    repeated.entry.binding.model = 'changed';
    assert.equal((await restored.getHolding(holding.accountId, holding.holdingId)).unitsRemaining, ['committed', 'receipt_prepared', 'receipt_committed'].includes(stopAt) ? 1 : 2);
    assert.equal((await restored.reserve(reserve())).entry.binding.model, 'model-a');
  }
});

test('inconsistent snapshots cannot manufacture balance, erase pending claims, or replay corrupted success', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  await store.move(move('dispatching', 'provider_succeeded', { providerResult }));
  await store.move(move('provider_succeeded', 'committed'));
  await store.move(move('committed', 'receipt_prepared', { receipt }));
  await store.move(move('receipt_prepared', 'receipt_committed', { receipt }));
  const edits = [
    (state) => { state.holdings[0].unitsRemaining = 2; },
    (state) => { state.entries.push(structuredClone(state.entries[0])); },
    (state) => { state.entries[0].providerResult.usage.totalUnits = 99; },
    (state) => { state.entries[0].receipt.accountId = 'another-account'; },
    (state) => { state.entries[0].holding.unitsRemaining = 2; },
    (state) => { state.entries[0].state = 'invalid'; },
    (state) => { state.entries[0].binding.grantId = 'another-grant'; },
    (state) => { state.totals = []; },
  ];
  for (const edit of edits) {
    const state = store.snapshot(); edit(state);
    assert.throws(() => new MemoryReservationStore({ snapshot: state }), /RESERVATION_INVALID/);
  }
  const pending = new MemoryReservationStore({ holdings: [holding] });
  await pending.reserve(reserve());
  const erased = pending.snapshot(); erased.entries = [];
  assert.throws(() => new MemoryReservationStore({ snapshot: erased }), /RESERVATION_INVALID/);
});

test('receipt preparation rejects unbound data and pins an immutable candidate before external writing', async () => {
  const store = new MemoryReservationStore({ holdings: [holding] });
  await store.reserve(reserve());
  await store.move(move('reserved', 'dispatching'));
  await store.move(move('dispatching', 'provider_succeeded', { providerResult }));
  await store.move(move('provider_succeeded', 'committed'));
  await assert.rejects(store.move(move('committed', 'receipt_prepared', { receipt: { ...receipt, accountId: 'other-account' } })), /RESERVATION_INVALID/);
  await assert.rejects(store.move(move('committed', 'receipt_committed', { receipt })), /RESERVATION_CONFLICT/);
  const prepared = await store.move(move('committed', 'receipt_prepared', { receipt }));
  assert.equal(prepared.state, 'receipt_prepared');
  prepared.receipt.receiptId = 'mutated-outside';
  const restored = new MemoryReservationStore({ snapshot: store.snapshot() });
  assert.equal((await restored.reserve(reserve())).entry.receipt.receiptId, receipt.receiptId);
  await assert.rejects(restored.move(move('receipt_prepared', 'receipt_committed', { receipt: { ...receipt, receiptId: 'writer-changed-id' } })), /RESERVATION_CONFLICT/);
  assert.equal((await restored.reserve(reserve())).entry.state, 'receipt_prepared');
  await restored.move(move('receipt_prepared', 'receipt_committed', { receipt }));
});
