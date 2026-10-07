import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HourKeyRuntime } from '../src/runtime.mjs';
import { MemoryReservationStore } from '../src/reservation-store.mjs';
import { ReservationUsageLedger } from '../src/reservation-usage-ledger.mjs';
import { MemoryClock, MemoryHourKeyPackagingPort, MemoryKeyVerifier, MemoryOfferCatalog, MemoryReceiptWriter, MemoryRequestHasher } from './support/fakes.mjs';

const slot = { slotStart: '2026-10-07T06:00:00.000Z', lockDeadline: '2026-10-07T05:55:00.000Z', slotEnd: '2026-10-07T07:00:00.000Z', timeZone: 'Asia/Shanghai' };
const resourceScope = { models: ['model-a'], providers: ['provider-a'], regions: ['region-a'] };
const key = { keyId: 'key-reservation', accountId: 'acct-reservation', grantIds: ['grant-reservation'], issuedAt: '2026-10-07T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', receiptUntil: '2026-10-09T00:00:00.000Z' };
const grant = { grantId: 'grant-reservation', accountId: key.accountId, version: 1, scopeEpoch: 1, resourceScope, capabilityScope: ['compute', 'usage.receipt'], slot,
  issuedAt: key.issuedAt, expiresAt: slot.slotEnd, receiptUntil: key.receiptUntil };

function controlledProvider() {
  const requests = [];
  const pending = [];
  let released = false;
  return {
    providerId: 'provider-a', requests,
    execute(request) {
      requests.push(request);
      const result = { status: 'succeeded', providerRequestId: `upstream-${requests.length}`, output: { content: request.input }, usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 } };
      return released ? Promise.resolve(result) : new Promise((resolve) => pending.push(() => resolve(result)));
    },
    release() {
      released = true;
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function fixture(units = 3) {
  const holding = { holdingId: 'holding-reservation', accountId: key.accountId, grantId: grant.grantId, offerId: 'offer-reservation', resourceScope, slot, unitsRemaining: units, status: 'held' };
  const store = new MemoryReservationStore({ holdings: [holding] });
  const provider = controlledProvider();
  const clock = new MemoryClock('2026-10-07T06:30:00.000Z');
  const receiptWriter = new MemoryReceiptWriter();
  const holdingPort = { get: (accountId, holdingId) => store.getHolding(accountId, holdingId), consume: async () => { throw new Error('LEGACY_CONSUME_MUST_NOT_RUN'); } };
  const runtimes = Array.from({ length: 2 }, () => new HourKeyRuntime({
    clock, keyVerifier: new MemoryKeyVerifier([['reservation-private-key', { key, grants: [grant] }]]),
    holdingPort, providerAdapters: new Map([['provider-a', provider]]), receiptWriter,
    hourKeyPackager: new MemoryHourKeyPackagingPort(), offerCatalog: new MemoryOfferCatalog(), requestHasher: new MemoryRequestHasher(),
    usageLedger: new ReservationUsageLedger({ store }),
  }));
  return { store, provider, clock, runtimes, holdingPort, receiptWriter,
    command: (idempotencyKey) => ({ requestId: `request-${idempotencyKey}`, opaqueKey: 'reservation-private-key', userText: '帮我写代码', holdingId: holding.holdingId,
      requestedResource: { model: 'model-a', provider: 'provider-a', region: 'region-a' }, providerInput: 'synthetic private result', idempotencyKey }),
  };
}

const drainPromises = async () => {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('atomic reservation permits same-Holding overlap within one Runtime and across two Runtime instances', async () => {
  const setup = fixture();
  const pending = [
    setup.runtimes[0].handle(setup.command('concurrent-operation-1')),
    setup.runtimes[0].handle(setup.command('concurrent-operation-2')),
    setup.runtimes[1].handle(setup.command('concurrent-operation-3')),
  ];
  try {
    await drainPromises();
    assert.equal(setup.provider.requests.length, 3);
    assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 3, available: 0, reserved: 3, committed: 0 });
  } finally {
    setup.provider.release();
    await Promise.all(pending);
  }
  const results = await Promise.all(pending);
  assert.equal(results.every((result) => result.kind === 'receipt'), true);
  assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 3, available: 0, reserved: 0, committed: 3 });
});

test('two Runtime instances sharing one reservation store never dispatch the same idempotent operation twice', async () => {
  const setup = fixture(1);
  const first = setup.runtimes[0].handle(setup.command('same-operation-id'));
  await drainPromises();
  const duplicate = await setup.runtimes[1].handle(setup.command('same-operation-id'));
  try {
    assert.equal(duplicate.kind, 'error');
    assert.equal(duplicate.error.code, 'EXECUTION_IN_PROGRESS');
    assert.equal(duplicate.error.retryable, false);
    assert.equal(setup.provider.requests.length, 1);
  } finally {
    setup.provider.release();
    await first;
  }
  const completed = await first;
  assert.equal(completed.kind, 'receipt');
  const replay = await setup.runtimes[1].handle(setup.command('same-operation-id'));
  assert.deepEqual(replay.output, completed.output);
  assert.deepEqual(replay.receipt, completed.receipt);
  assert.equal(setup.provider.requests.length, 1);
});

test('the final available unit is reserved before Provider dispatch while a competing request is refused', async () => {
  const setup = fixture(1);
  const first = setup.runtimes[0].handle(setup.command('last-unit-operation'));
  await drainPromises();
  const competing = await setup.runtimes[1].handle(setup.command('competing-operation'));
  try {
    assert.equal(competing.kind, 'error');
    assert.equal(competing.error.code, 'HOLDING_EXHAUSTED');
    assert.equal(setup.provider.requests.length, 1);
    assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 1, available: 0, reserved: 1, committed: 0 });
  } finally {
    setup.provider.release();
    await first;
  }
  assert.equal((await first).kind, 'receipt');
  assert.equal(setup.receiptWriter.appendCalls, 1);
});

test('asynchronous reservation persistence crossing the window end prevents a fresh Provider call', async () => {
  const setup = fixture(1);
  setup.provider.release();
  setup.clock.set('2026-10-07T06:59:59.999Z');
  const reserve = setup.store.reserve.bind(setup.store);
  setup.store.reserve = async (command) => {
    const result = await reserve(command);
    setup.clock.set('2026-10-07T07:00:00.001Z');
    return result;
  };
  const result = await setup.runtimes[0].handle(setup.command('reservation-crossed-window'));
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'SLOT_NOT_ACTIVE');
  assert.equal(setup.provider.requests.length, 0);
  assert.equal(setup.receiptWriter.appendCalls, 0);
  assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 1, available: 1, reserved: 0, committed: 0 });
});

test('a persisted dispatch marker crossing the window end is released without calling Provider', async () => {
  const setup = fixture(1);
  setup.provider.release();
  setup.clock.set('2026-10-07T06:59:59.999Z');
  const move = setup.store.move.bind(setup.store);
  setup.store.move = async (command) => {
    const result = await move(command);
    if (command.to === 'dispatching') setup.clock.set('2026-10-07T07:00:00.001Z');
    return result;
  };
  const result = await setup.runtimes[0].handle(setup.command('dispatch-crossed-window'));
  assert.equal(result.kind, 'error');
  assert.equal(result.error.code, 'SLOT_NOT_ACTIVE');
  assert.equal(setup.provider.requests.length, 0);
  assert.equal(setup.receiptWriter.appendCalls, 0);
  assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 1, available: 1, reserved: 0, committed: 0 });
});

test('an admitted Provider operation may settle after the window closes while a new Compute is denied', async () => {
  const setup = fixture(2);
  const first = setup.runtimes[0].handle(setup.command('admitted-before-close'));
  await drainPromises();
  setup.clock.set('2026-10-07T07:00:00.001Z');
  setup.provider.release();
  const settled = await first;
  assert.equal(settled.kind, 'receipt');
  const rejected = await setup.runtimes[1].handle(setup.command('new-after-close'));
  assert.equal(rejected.kind, 'policy');
  assert.equal(rejected.decision.allowed, false);
  assert.equal(setup.provider.requests.length, 1);
  assert.deepEqual(await setup.store.inspect(key.accountId, 'holding-reservation'), { total: 2, available: 1, reserved: 0, committed: 1 });
});
