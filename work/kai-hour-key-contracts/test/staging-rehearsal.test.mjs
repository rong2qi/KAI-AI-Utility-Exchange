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
import { StagingReleaseFacade } from '../src/staging-release-facade.mjs';
import { toUserFacingReleaseResult as toPublicReleaseResult } from '../src/release-user-result.mjs';
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

test('artifact registry uses the transactional store port instead of a concrete store', async () => {
  const fence = new StagingFence();
  const baseStore = new StagingTransactionalStore({
    fence,
    initial: { artifacts: {}, activeVersion: null, history: [] },
  });
  let transactions = 0;
  const store = {
    snapshot: () => baseStore.snapshot(),
    transact: async (token, mutator) => {
      transactions += 1;
      return baseStore.transact(token, mutator);
    },
  };
  const registry = new StagingArtifactRegistry({ fence, store });
  const lease = fence.acquire('port-contract-worker');
  await registry.publish({ version: 'v-port', contents: 'artifact-port', manifest: manifestFor('v-port', 'artifact-port') }, lease);
  assert.equal(transactions, 1);
  assert.equal(registry.getArtifact('v-port').version, 'v-port');
});

test('artifact registry rejects an object that does not implement the transaction store port', () => {
  assert.throws(
    () => new StagingArtifactRegistry({ store: {} }),
    (error) => error.code === 'TRANSACTION_STORE_REQUIRED',
  );
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

test('user release result exposes a compact activated status without gate internals', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const manifest = manifestFor('v-user', 'artifact-user');
  await registry.publish({ version: 'v-user', contents: 'artifact-user', manifest }, lease);

  const result = await controller.releaseForUser({
    manifest,
    checks: [{ name: 'startup', status: 'passed', required: true }],
    token: lease,
  });

  assert.deepEqual(result, {
    status: 'activated',
    label: '已激活',
    message: '版本已完成检查并启用。',
    version: 'v-user',
    actionRequired: false,
  });
  assert.equal('gateId' in result, false);
  assert.equal('checks' in result, false);
  assert.equal('digest' in result, false);
});

test('user release result maps rollback and blocked outcomes to actionable language', () => {
  assert.deepEqual(toPublicReleaseResult({
    decision: 'rollback',
    rollbackTo: { version: 'v1', digest: 'd'.repeat(64) },
    reasonCode: 'REQUIRED_HEALTH_CHECK_FAILED',
  }), {
    status: 'rolled_back',
    label: '已自动回滚',
    message: '新版本检查未通过，系统已恢复上一版本。',
    restoredVersion: 'v1',
    actionRequired: false,
    nextAction: 'review_checks',
  });
  assert.deepEqual(toPublicReleaseResult({
    decision: 'blocked',
    reasonCode: 'NO_VERIFIED_PREVIOUS_ARTIFACT',
  }), {
    status: 'needs_attention',
    label: '需要处理',
    message: '检查未通过，当前没有可恢复的上一版本。',
    actionRequired: true,
    nextAction: 'fix_checks_and_publish_again',
  });
});

test('user preview reports ready without activating or writing history', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const manifest = manifestFor('v-preview', 'artifact-preview');
  await registry.publish({ version: 'v-preview', contents: 'artifact-preview', manifest }, lease);

  const result = await controller.previewForUser({
    manifest,
    checks: [{ name: 'startup', status: 'passed', required: true }],
    token: lease,
  });

  assert.deepEqual(result, {
    status: 'ready',
    label: '可发布',
    message: '版本已通过检查，可以发布。',
    version: 'v-preview',
    actionRequired: true,
    nextAction: 'approve_release',
  });
  assert.equal(registry.snapshot().activeVersion, null);
  assert.equal(registry.snapshot().history.length, 0);
});

test('release facade accepts only a candidate version and assembles internal inputs automatically', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');
  const manifest = manifestFor('v-facade', 'artifact-facade');
  await registry.publish({ version: 'v-facade', contents: 'artifact-facade', manifest }, lease);
  const calls = [];
  const facade = new StagingReleaseFacade({
    controller,
    getCandidate: async (version) => {
      calls.push(['candidate', version]);
      return registry.getArtifact(version);
    },
    runHealthChecks: async ({ candidate }) => {
      calls.push(['health', candidate.version]);
      return [{ name: 'startup', status: 'passed', required: true }];
    },
    acquireToken: async () => {
      calls.push(['token']);
      return lease;
    },
  });

  const preview = await facade.preview({ version: 'v-facade' });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(calls, [['candidate', 'v-facade'], ['health', 'v-facade']]);
  calls.length = 0;
  const result = await facade.publish({ version: 'v-facade' });

  assert.deepEqual(result, {
    status: 'activated',
    label: '已激活',
    message: '版本已完成检查并启用。',
    version: 'v-facade',
    actionRequired: false,
  });
  assert.deepEqual(calls, [['candidate', 'v-facade'], ['health', 'v-facade'], ['token']]);
});

test('release facade hides ordinary loader failures from the user result', async () => {
  const facade = new StagingReleaseFacade({
    controller: {
      releaseForUser: async () => { throw new Error('internal loader secret'); },
      previewForUser: async () => { throw new Error('internal loader secret'); },
    },
    getCandidate: async () => { throw new Error('internal loader secret'); },
    runHealthChecks: async () => [],
    acquireToken: async () => undefined,
  });

  const result = await facade.publish({ version: 'v-failure' });

  assert.deepEqual(result, {
    status: 'needs_attention',
    label: '需要处理',
    message: '发布状态暂时无法确认，请修正后重试。',
    actionRequired: true,
    nextAction: 'retry_release',
  });
  assert.equal(result.message.includes('internal'), false);
});

test('user release result hides internal validation errors behind a retry action', async () => {
  const fence = new StagingFence();
  const registry = new StagingArtifactRegistry({ fence });
  const controller = new StagingDeploymentController({ registry });
  const lease = fence.acquire('release-controller');

  const result = await controller.releaseForUser({
    manifest: {},
    checks: [{ name: 'startup', status: 'passed', required: true }],
    token: lease,
  });

  assert.deepEqual(result, {
    status: 'needs_attention',
    label: '需要处理',
    message: '发布状态暂时无法确认，请修正后重试。',
    actionRequired: true,
    nextAction: 'retry_release',
  });
  assert.equal('code' in result, false);
  assert.equal('stack' in result, false);
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
