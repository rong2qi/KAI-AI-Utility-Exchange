import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonUsageExecutionLedgerStore } from '../src/adapters/json-usage-execution-ledger-store.mjs';
import {
  StagingArtifactRegistry,
  StagingDeploymentController,
  StagingFence,
  StagingTransactionalStore,
  artifactDigest,
} from '../src/staging-rehearsal.mjs';
import { UsageExecutionLedger } from '../src/usage-ledger.mjs';

const manifestFor = (version, contents, overrides = {}) => ({
  version,
  sourceCommit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
  packageLockSha256: 'c'.repeat(64),
  nodeRange: '>=22.0.0 <25.0.0',
  providerModel: 'spark-x2.5-4b',
  artifactSha256: artifactDigest(contents),
  createdAt: '2026-10-04T02:00:00.000Z',
  ...overrides,
});

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
  const first = await registry.publish({ version: 'v1', contents: 'artifact-v1', manifest: manifestFor('v1', 'artifact-v1') }, lease);
  const second = await registry.publish({ version: 'v2', contents: 'artifact-v2', manifest: manifestFor('v2', 'artifact-v2') }, lease);
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

test('release gate activates a manifest-backed artifact after required checks pass and ignores warnings', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const contents = 'artifact-v2';
  const manifest = manifestFor('v2', contents);
  await registry.publish({ version: 'v2', contents, manifest }, lease);

  const result = await controller.release({
    manifest,
    checks: [
      { name: 'startup', status: 'passed', required: true },
      { name: 'contract', status: 'passed', required: true },
      { name: 'provider-sandbox', status: 'warning', required: false, detail: 'sandbox only' },
    ],
    token: lease,
  });

  assert.equal(result.decision, 'activate');
  assert.equal(result.version, 'v2');
  assert.equal(registry.snapshot().activeVersion, 'v2');
  assert.equal(registry.snapshot().history.at(-1).action, 'activate');
  assert.equal(registry.snapshot().history.at(-1).gateId, result.gateId);
});

test('failed required health check automatically rolls back to the verified previous artifact', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const firstContents = 'artifact-v1';
  const secondContents = 'artifact-v2';
  const firstManifest = manifestFor('v1', firstContents);
  const secondManifest = manifestFor('v2', secondContents);
  const first = await registry.publish({ version: 'v1', contents: firstContents, manifest: firstManifest }, lease);
  await registry.publish({ version: 'v2', contents: secondContents, manifest: secondManifest }, lease);
  await registry.activate({ version: first.version, digest: first.digest }, lease);

  const result = await controller.release({
    manifest: secondManifest,
    checks: [
      { name: 'startup', status: 'passed', required: true },
      { name: 'contract', status: 'failed', required: true, detail: 'contract mismatch' },
    ],
    token: lease,
  });

  assert.equal(result.decision, 'rollback');
  assert.equal(result.rollbackTo.version, 'v1');
  assert.equal(registry.snapshot().activeVersion, 'v1');
  assert.deepEqual(registry.snapshot().history.at(-1), {
    action: 'rollback',
    version: 'v1',
    digest: first.digest,
    reason: 'REQUIRED_HEALTH_CHECK_FAILED',
    gateId: result.gateId,
    result,
  });
});

test('release gate blocks when required checks fail and no verified previous artifact exists', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const contents = 'artifact-v1';
  const manifest = manifestFor('v1', contents);
  await registry.publish({ version: 'v1', contents, manifest }, lease);

  const result = await controller.release({
    manifest,
    checks: [{ name: 'startup', status: 'failed', required: true }],
    token: lease,
  });

  assert.equal(result.decision, 'blocked');
  assert.equal(result.reasonCode, 'NO_VERIFIED_PREVIOUS_ARTIFACT');
  assert.equal(registry.snapshot().activeVersion, null);
  assert.equal(registry.snapshot().history.length, 0);
});

test('same release gate is idempotent and does not duplicate audit history', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const contents = 'artifact-v1';
  const manifest = manifestFor('v1', contents);
  await registry.publish({ version: 'v1', contents, manifest }, lease);
  const input = {
    manifest,
    checks: [{ name: 'startup', status: 'passed', required: true }],
    token: lease,
  };

  const first = await controller.release(input);
  const second = await controller.release(input);

  assert.equal(second.gateId, first.gateId);
  assert.deepEqual(second, first);
  assert.equal(registry.snapshot().history.length, 1);
});

test('release gate rejects manifest and artifact digest mismatch without activation', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const contents = 'artifact-v1';
  const manifest = manifestFor('v1', contents, { artifactSha256: 'd'.repeat(64) });
  await assert.rejects(
    registry.publish({ version: 'v1', contents, manifest }, lease),
    (error) => error.code === 'ARTIFACT_MANIFEST_DIGEST_MISMATCH',
  );
  const validManifest = manifestFor('v1', contents);
  await registry.publish({ version: 'v1', contents, manifest: validManifest }, lease);
  const result = await controller.release({
    manifest: { ...validManifest, sourceFingerprint: 'e'.repeat(64) },
    checks: [{ name: 'startup', status: 'passed', required: true }],
    token: lease,
  });
  assert.equal(result.decision, 'blocked');
  assert.equal(result.reasonCode, 'MANIFEST_MISMATCH');
  assert.equal(registry.snapshot().activeVersion, null);
});

test('a superseded fence cannot write an automatic rollback', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const firstLease = fence.acquire('release-controller-a');
  const firstManifest = manifestFor('v1', 'artifact-v1');
  const secondManifest = manifestFor('v2', 'artifact-v2');
  const first = await registry.publish({ version: 'v1', contents: 'artifact-v1', manifest: firstManifest }, firstLease);
  await registry.publish({ version: 'v2', contents: 'artifact-v2', manifest: secondManifest }, firstLease);
  await registry.activate({ version: first.version, digest: first.digest }, firstLease);
  const currentLease = fence.acquire('release-controller-b');

  await assert.rejects(
    controller.release({
      manifest: secondManifest,
      checks: [{ name: 'contract', status: 'failed', required: true }],
      token: firstLease,
    }),
    (error) => error.code === 'STALE_FENCE_TOKEN',
  );
  assert.equal(registry.snapshot().activeVersion, 'v1');
  assert.equal(registry.snapshot().history.length, 1);
  await registry.activate({ version: first.version, digest: first.digest }, currentLease);
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
