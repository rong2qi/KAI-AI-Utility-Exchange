import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalStagingTarget } from '../src/adapters/local-staging-target.mjs';

const artifact = (version, digest = `${version}-digest`) => ({ version, digest });

test('local staging target declares its dry-run boundary before any activation', async () => {
  const target = new LocalStagingTarget();

  assert.deepEqual(await target.inspect(), {
    targetId: 'local-dry-run',
    networkDisabled: true,
    realStagingProof: false,
    active: null,
  });
});

test('local staging target activates an artifact and reports a passing health check', async () => {
  const target = new LocalStagingTarget();
  const candidate = artifact('v1');

  const activated = await target.activate(candidate);
  const health = await target.healthCheck(candidate);

  assert.deepEqual(activated, { status: 'activated', ...candidate });
  assert.deepEqual(health, { status: 'passed', version: 'v1', digest: 'v1-digest' });
  assert.deepEqual((await target.inspect()).active, candidate);
});

test('failed health check rolls back to the requested previous artifact', async () => {
  const target = new LocalStagingTarget({ healthByVersion: { v2: 'failed' } });
  const previous = artifact('v1');
  const candidate = artifact('v2');
  await target.activate(previous);
  await target.activate(candidate);

  assert.deepEqual(await target.healthCheck(candidate), {
    status: 'failed',
    version: 'v2',
    digest: 'v2-digest',
    reason: 'configured_local_failure',
  });
  assert.deepEqual(await target.rollback({ ...previous, reason: 'health_check_failed' }), {
    status: 'rolled_back',
    version: 'v1',
    digest: 'v1-digest',
    reason: 'health_check_failed',
  });
  assert.deepEqual((await target.inspect()).active, previous);
});

test('target rejects health checks and rollback for a non-active or malformed artifact', async () => {
  const target = new LocalStagingTarget();
  await assert.rejects(target.healthCheck(artifact('v1')), (error) => error.code === 'TARGET_VERSION_NOT_ACTIVE');
  await assert.rejects(target.activate({ version: '', digest: 'digest' }), (error) => error.code === 'TARGET_ARTIFACT_INVALID');
  await assert.rejects(target.rollback({ version: 'v1', digest: 'tampered', reason: 'test' }), (error) => error.code === 'TARGET_ROLLBACK_DIGEST_MISMATCH');
});

test('target audit history contains lifecycle facts without credentials', async () => {
  const target = new LocalStagingTarget();
  await target.activate(artifact('v1'));
  const snapshot = target.snapshot();

  assert.equal(snapshot.history.length, 1);
  assert.equal('secret' in snapshot.history[0], false);
  assert.equal('token' in snapshot.history[0], false);
});
