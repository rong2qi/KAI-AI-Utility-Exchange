import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonUsageExecutionLedgerStore } from '../src/adapters/json-usage-execution-ledger-store.mjs';
import { StagingArtifactRegistry, StagingFence, StagingTransactionalStore } from '../src/staging-rehearsal.mjs';
import { UsageExecutionLedger } from '../src/usage-ledger.mjs';

test('a stale staging worker cannot commit after a newer fence is acquired', async () => {
  const fence = new StagingFence();
  const store = new StagingTransactionalStore({ fence });
  const first = fence.acquire('worker-a');
  const blocked = store.transact(first, async (draft) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    draft.value = 'stale-write';
    return draft.value;
  });
  const second = fence.acquire('worker-b');
  await assert.rejects(blocked, (error) => error.code === 'STALE_FENCE_TOKEN');
  await store.transact(second, (draft) => {
    draft.value = 'current-write';
    return draft.value;
  });
  assert.equal(store.snapshot().value, 'current-write');
});

test('artifact activation and rollback require a matching immutable digest', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const lease = fence.acquire('release-controller');
  const first = await registry.publish({ version: 'v1', contents: 'artifact-v1' }, lease);
  const second = await registry.publish({ version: 'v2', contents: 'artifact-v2' }, lease);
  await registry.activate({ version: first.version, digest: first.digest }, lease);
  await registry.activate({ version: second.version, digest: second.digest }, lease);
  await assert.rejects(
    registry.rollback({ version: 'v1', digest: 'tampered', reason: 'failed-healthcheck' }, lease),
    (error) => error.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
  await registry.rollback({ version: first.version, digest: first.digest, reason: 'failed-healthcheck' }, lease);
  assert.equal(registry.snapshot().activeVersion, 'v1');
  assert.equal(registry.snapshot().history.at(-1).action, 'rollback');
});

test('restart recovery reuses the recorded Provider result exactly once', async () => {
  const directory = await mkdtemp(join('/private/tmp', 'kai-staging-rehearsal-'));
  try {
    const storePath = join(directory, 'ledger.json');
    let providerCalls = 0;
    let holdingCalls = 0;
    let receiptCalls = 0;
    let failReceipt = true;
    const providerAdapter = { execute: async () => {
      providerCalls += 1;
      return { providerRequestId: 'provider-staging-1', output: { content: 'OK' }, usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 }, status: 'succeeded' };
    } };
    const holdingPort = { consume: async () => {
      holdingCalls += 1;
      return { holdingId: 'holding-1', unitsRemaining: 0, status: 'exhausted' };
    } };
    const receiptWriter = { append: async (receipt) => {
      receiptCalls += 1;
      if (failReceipt) {
        failReceipt = false;
        throw new Error('temporary receipt outage');
      }
      return receipt;
    } };
    const command = {
      accountId: 'account-staging', idempotencyKey: 'staging-recovery-1', requestHash: 'request-hash-1',
      model: 'spark-x2.5-4b', region: 'cn-huabei-1', providerInput: { messages: [{ role: 'user', content: 'OK' }] },
      requestId: 'request-staging-1', holdingId: 'holding-1', at: '2026-10-04T01:00:00.000Z',
      providerAdapter, holdingPort, receiptWriter,
      buildReceipt: ({ providerResult, holding }) => ({ providerResult, holding, status: 'succeeded' }),
    };
    const firstLedger = new UsageExecutionLedger({ store: new JsonUsageExecutionLedgerStore({ filePath: storePath }) });
    await assert.rejects(firstLedger.execute(command), /RECEIPT_WRITE_FAILED/);
    const restartedLedger = new UsageExecutionLedger({ store: new JsonUsageExecutionLedgerStore({ filePath: storePath }) });
    const receipt = await restartedLedger.execute(command);
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual({ providerCalls, holdingCalls, receiptCalls }, { providerCalls: 1, holdingCalls: 1, receiptCalls: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
