import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonUsageExecutionLedgerStore } from '../src/adapters/json-usage-execution-ledger-store.mjs';
import { MemoryUsageExecutionLedgerStore, UsageExecutionLedger } from '../src/usage-ledger.mjs';

function makeCommand({ store = new MemoryUsageExecutionLedgerStore(), idempotencyKey = 'idem_1', requestHash = 'hash_1', input = 'hello' } = {}) {
  const calls = { provider: 0, consume: 0, append: 0 };
  let receiptFailure = false;
  const providerAdapter = {
    async execute(request) {
      calls.provider += 1;
      assert.notEqual(request.idempotencyKey, idempotencyKey);
      assert.match(request.idempotencyKey, /^kai_[a-f0-9]{64}$/);
      return {
        providerRequestId: 'provider_' + idempotencyKey,
        output: { echo: request.input },
        usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 },
        status: 'succeeded',
      };
    },
  };
  const holdingPort = {
    async consume(command) {
      calls.consume += 1;
      assert.equal(command.idempotencyKey, idempotencyKey);
      return { holdingId: 'holding_1', offerId: 'offer_1', slot: {}, unitsRemaining: 1, status: 'active' };
    },
  };
  const receiptWriter = {
    async append(receipt) {
      calls.append += 1;
      if (receiptFailure) throw new Error('RECEIPT_DOWN');
      return receipt;
    },
  };
  const command = {
    accountId: 'acct_1',
    keyId: 'key_1',
    grantId: 'grant_1',
    holdingId: 'holding_1',
    offerId: 'offer_1',
    model: 'model-a',
    provider: 'provider-a',
    region: 'region-a',
    providerInput: input,
    requestId: 'request_1',
    idempotencyKey,
    requestHash,
    at: '2026-10-02T18:10:00.000Z',
    providerAdapter,
    holdingPort,
    receiptWriter,
    buildReceipt: ({ providerResult, holding }) => ({
      receiptId: 'receipt_' + idempotencyKey,
      accountId: 'acct_1',
      idempotencyKey,
      hourKeyStatus: 'packaged',
      requestHash,
      holdingId: holding.holdingId,
      offerId: holding.offerId,
      usage: providerResult.usage,
    }),
  };
  return { command, calls, setReceiptFailure: (value) => { receiptFailure = value; }, store };
}

test('usage ledger commits provider, Holding, and Receipt in resumable states', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  const receipt = await ledger.execute(setup.command);
  assert.equal(receipt.receiptId, 'receipt_idem_1');
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
  const entry = await setup.store.get('acct_1', 'idem_1');
  assert.equal(entry.state, 'receipt_committed');
  assert.equal(entry.providerResult.providerRequestId, 'provider_idem_1');
});

test('Compute result replays Provider output without repeating settlement or sharing mutable state', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  const result = await ledger.executeWithResult(setup.command);
  assert.equal(result.receipt.receiptId, 'receipt_idem_1');
  assert.deepEqual(result.output, { echo: 'hello' });
  result.output.echo = 'caller changed output';
  result.receipt.receiptId = 'caller changed receipt';
  const repeated = await ledger.executeWithResult({ ...setup.command, requestId: 'request_retry' });
  assert.deepEqual(repeated.output, { echo: 'hello' });
  assert.equal(repeated.receipt.receiptId, 'receipt_idem_1');
  assert.deepEqual(await ledger.execute(setup.command), repeated.receipt);
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
});

test('receipt-only and Compute-result callers share one execution lock', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  const [receipt, result] = await Promise.all([
    ledger.execute(setup.command),
    ledger.executeWithResult({ ...setup.command, requestId: 'request_concurrent' }),
  ]);
  assert.deepEqual(result.receipt, receipt);
  assert.deepEqual(result.output, { echo: 'hello' });
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
});

test('Receipt failure resumes from the durable Holding state without repeating side effects', async () => {
  const setup = makeCommand();
  setup.setReceiptFailure(true);
  await assert.rejects(new UsageExecutionLedger({ store: setup.store }).execute(setup.command), /RECEIPT_WRITE_FAILED/);
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
  assert.equal((await setup.store.get('acct_1', 'idem_1')).state, 'holding_consumed');

  setup.setReceiptFailure(false);
  const restarted = new UsageExecutionLedger({ store: setup.store });
  const receipt = await restarted.execute({ ...setup.command, requestId: 'request_retry' });
  assert.equal(receipt.receiptId, 'receipt_idem_1');
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 2 });
});

test('same idempotency key with different request facts is rejected', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  await ledger.execute(setup.command);
  await assert.rejects(ledger.execute({ ...setup.command, requestHash: 'hash_2', providerInput: 'different' }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
});

test('same request hash cannot replay against different authorization, Holding or resource facts', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  await ledger.execute(setup.command);
  for (const field of ['keyId', 'grantId', 'holdingId', 'offerId', 'model', 'provider', 'region']) {
    await assert.rejects(ledger.executeWithResult({ ...setup.command, [field]: `${field}_other` }), /IDEMPOTENCY_CONFLICT/, field);
  }
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
});

test('account and idempotency identifiers remain separate even when they contain separators', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  setup.command.providerAdapter.execute = async ({ input }) => {
    setup.calls.provider += 1;
    return { status: 'succeeded', output: input, usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 } };
  };
  setup.command.holdingPort.consume = async () => ({ holdingId: 'holding_1', offerId: 'offer_1' });
  const first = await ledger.executeWithResult({ ...setup.command, accountId: 'acct:one', idempotencyKey: 'same', providerInput: 'first' });
  const second = await ledger.executeWithResult({ ...setup.command, accountId: 'acct', idempotencyKey: 'one:same', providerInput: 'second' });
  assert.equal(first.output, 'first');
  assert.equal(second.output, 'second');
  assert.equal(setup.calls.provider, 2);
});

test('different accounts sharing a Provider adapter never share upstream idempotency tokens', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  const upstreamResults = new Map();
  const tokens = [];
  setup.command.providerAdapter.execute = async ({ idempotencyKey, input }) => {
    tokens.push(idempotencyKey);
    if (!upstreamResults.has(idempotencyKey)) upstreamResults.set(idempotencyKey, { status: 'succeeded', output: input, usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 } });
    return upstreamResults.get(idempotencyKey);
  };
  const first = await ledger.executeWithResult({ ...setup.command, accountId: 'acct_1', providerInput: 'private account one' });
  const second = await ledger.executeWithResult({ ...setup.command, accountId: 'acct_2', providerInput: 'private account two' });
  assert.equal(first.output, 'private account one');
  assert.equal(second.output, 'private account two');
  assert.notEqual(tokens[0], tokens[1]);
  assert.match(tokens[0], /^kai_[a-f0-9]{64}$/);
  assert.equal(first.receipt.idempotencyKey, setup.command.idempotencyKey);
});

test('concurrent calls serialize one execution per idempotency key', async () => {
  const setup = makeCommand();
  const ledger = new UsageExecutionLedger({ store: setup.store });
  const [first, second] = await Promise.all([
    ledger.execute(setup.command),
    ledger.execute({ ...setup.command, requestId: 'request_concurrent_retry' }),
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 1 });
});

test('JSON ledger store survives a new ledger instance after Receipt failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-usage-ledger-'));
  try {
    const store = new JsonUsageExecutionLedgerStore({ filePath: join(directory, 'ledger.json') });
    const setup = makeCommand({ store });
    setup.setReceiptFailure(true);
    await assert.rejects(new UsageExecutionLedger({ store }).execute(setup.command), /RECEIPT_WRITE_FAILED/);

    const restartedStore = new JsonUsageExecutionLedgerStore({ filePath: join(directory, 'ledger.json') });
    setup.setReceiptFailure(false);
    const result = await new UsageExecutionLedger({ store: restartedStore }).executeWithResult({ ...setup.command, requestId: 'request_after_restart' });
    assert.equal(result.receipt.receiptId, 'receipt_idem_1');
    assert.deepEqual(result.output, { echo: 'hello' });
    assert.deepEqual(setup.calls, { provider: 1, consume: 1, append: 2 });
    assert.equal((await restartedStore.get('acct_1', 'idem_1')).state, 'receipt_committed');
    assert.equal(JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
