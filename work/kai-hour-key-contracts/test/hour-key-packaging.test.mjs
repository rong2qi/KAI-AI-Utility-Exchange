import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HourKeyPackagingAdapter } from '../src/adapters/hour-key-packaging.mjs';
import { JsonHourKeyPackagingStore } from '../src/adapters/json-hour-key-packaging-store.mjs';

const offer = {
  offerId: 'offer_a',
  resource: { model: 'model-a', provider: 'reference-market', region: 'region-a' },
  slot: {
    slotStart: '2026-10-02T18:00:00.000Z',
    lockDeadline: '2026-10-02T17:55:00.000Z',
    slotEnd: '2026-10-02T19:00:00.000Z',
    timeZone: 'Asia/Shanghai',
  },
  price: { amount: '1.20', currency: 'CNY', unit: 'GPU_HOUR' },
  availability: 'available',
  retrievedAt: '2026-10-02T17:50:00.000Z',
  validUntil: '2026-10-02T17:55:00.000Z',
  sourceUrl: 'https://kai.com/offers/offer_a',
  executionEligible: true,
  hourKeyStatus: 'unpackaged',
};

test('packages a real market Offer without changing market facts', async () => {
  const adapter = new HourKeyPackagingAdapter();
  const packaged = await adapter.package({ accountId: 'acct_1', offer, idempotencyKey: 'idem_1' });
  assert.equal(packaged.hourKeyStatus, 'packaged');
  assert.equal(packaged.executionEligible, true);
  assert.deepEqual({
    offerId: packaged.offerId,
    resource: packaged.resource,
    slot: packaged.slot,
    price: packaged.price,
    availability: packaged.availability,
    retrievedAt: packaged.retrievedAt,
    validUntil: packaged.validUntil,
    sourceUrl: packaged.sourceUrl,
  }, {
    offerId: offer.offerId,
    resource: offer.resource,
    slot: offer.slot,
    price: offer.price,
    availability: offer.availability,
    retrievedAt: offer.retrievedAt,
    validUntil: offer.validUntil,
    sourceUrl: offer.sourceUrl,
  });
  assert.equal(offer.hourKeyStatus, 'unpackaged');
});

test('packaging is idempotent for the same account command', async () => {
  const adapter = new HourKeyPackagingAdapter();
  const command = { accountId: 'acct_1', offer, idempotencyKey: 'idem_1' };
  const first = await adapter.package(command);
  const repeated = await adapter.package(command);
  assert.deepEqual(repeated, first);
});

test('packaging rejects a conflicting idempotency key without overwriting the first Offer', async () => {
  const adapter = new HourKeyPackagingAdapter();
  await adapter.package({ accountId: 'acct_1', offer, idempotencyKey: 'idem_1' });
  await assert.rejects(
    adapter.package({ accountId: 'acct_1', offer: { ...offer, offerId: 'offer_b' }, idempotencyKey: 'idem_1' }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test('packaging rejects an unavailable or ineligible Offer, including malformed packaged input', async () => {
  const adapter = new HourKeyPackagingAdapter();
  await assert.rejects(
    adapter.package({ accountId: 'acct_1', offer: { ...offer, availability: 'unavailable' }, idempotencyKey: 'idem_unavailable' }),
    /OFFER_UNAVAILABLE/,
  );
  await assert.rejects(
    adapter.package({ accountId: 'acct_1', offer: { ...offer, hourKeyStatus: 'packaged', executionEligible: false }, idempotencyKey: 'idem_ineligible' }),
    /OFFER_NOT_EXECUTION_ELIGIBLE/,
  );
});

test('concurrent duplicate packaging returns one stable result', async () => {
  const adapter = new HourKeyPackagingAdapter();
  const command = { accountId: 'acct_1', offer, idempotencyKey: 'idem_concurrent' };
  const results = await Promise.all([adapter.package(command), adapter.package(command)]);
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].hourKeyStatus, 'packaged');
});


test('JSON packaging store survives adapter recreation and concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-hour-key-packaging-'));
  try {
    const filePath = join(directory, 'packaging.json');
    const command = { accountId: 'acct_1', offer, idempotencyKey: 'idem_restart' };
    const first = await new HourKeyPackagingAdapter({ store: new JsonHourKeyPackagingStore({ filePath }) }).package(command);
    const restarted = new HourKeyPackagingAdapter({ store: new JsonHourKeyPackagingStore({ filePath }) });
    assert.deepEqual(await restarted.package(command), first);
    await assert.rejects(
      restarted.package({ ...command, offer: { ...offer, price: { ...offer.price, amount: '9.99' } } }),
      /IDEMPOTENCY_CONFLICT/,
    );

    const coldFilePath = join(directory, 'concurrent.json');
    const results = await Promise.all(Array.from({ length: 4 }, () => (
      new HourKeyPackagingAdapter({ store: new JsonHourKeyPackagingStore({ filePath: coldFilePath }) }).package({
        accountId: 'acct_1', offer, idempotencyKey: 'idem_concurrent_restart',
      })
    )));
    results.forEach((result) => assert.deepEqual(result, results[0]));
    const records = JSON.parse(await readFile(coldFilePath, 'utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].offer.hourKeyStatus, 'packaged');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt packaging state fails without leaving a lock file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-hour-key-packaging-corrupt-'));
  try {
    const filePath = join(directory, 'packaging.json');
    await writeFile(filePath, '{"broken":true}\n');
    const adapter = new HourKeyPackagingAdapter({ store: new JsonHourKeyPackagingStore({ filePath }) });
    await assert.rejects(
      adapter.package({ accountId: 'acct_1', offer, idempotencyKey: 'idem_corrupt' }),
      /PACKAGING_STORE_CORRUPT/,
    );
    await assert.rejects(readFile(filePath + '.lock'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
