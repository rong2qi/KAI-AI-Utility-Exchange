import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StagingArtifactSlots } from '../src/staging-artifact-slots.mjs';

const artifact = (version, contents = `contents-${version}`) => ({ version, contents });

test('artifact slots keep current and previous immutable releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await slots.install(artifact('v1'));
  await slots.activate('v1');
  await slots.install(artifact('v2'));
  await slots.activate('v2');

  const snapshot = await slots.snapshot();
  assert.equal(snapshot.current.version, 'v2');
  assert.equal(snapshot.previous.version, 'v1');
  assert.equal(snapshot.current.digest, snapshot.releases.v2.digest);
  assert.equal(snapshot.previous.digest, snapshot.releases.v1.digest);
  assert.deepEqual(await slots.read('v1'), artifact('v1'));
});

test('activating a third release keeps only the current and previous slots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  for (const version of ['v1', 'v2', 'v3']) {
    await slots.install(artifact(version));
    await slots.activate(version);
  }

  const snapshot = await slots.snapshot();
  assert.equal(snapshot.current.version, 'v3');
  assert.equal(snapshot.previous.version, 'v2');
  assert.deepEqual(Object.keys(snapshot.releases).sort(), ['v2', 'v3']);
  await assert.rejects(slots.read('v1'), (error) => error.code === 'STAGING_ARTIFACT_NOT_FOUND');
});

test('rollback swaps current and previous while preserving both digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await slots.install(artifact('v1'));
  await slots.activate('v1');
  await slots.install(artifact('v2'));
  await slots.activate('v2');

  const result = await slots.rollback();
  assert.deepEqual(result, { status: 'rolled_back', version: 'v1', digest: 'e29d8ca58e821c8111b79d9beb8933f36225a1ae7384a58cc55f596a774dc25e' });
  const snapshot = await slots.snapshot();
  assert.equal(snapshot.current.version, 'v1');
  assert.equal(snapshot.previous.version, 'v2');
});

test('artifact slots reject conflicting or tampered releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await slots.install(artifact('v1'));
  await assert.rejects(slots.install({ version: 'v1', contents: 'changed' }), (error) => error.code === 'STAGING_ARTIFACT_CONFLICT');
  await assert.rejects(slots.install({ version: 'v2', contents: 'contents-v2', digest: 'tampered' }), (error) => error.code === 'STAGING_ARTIFACT_DIGEST_MISMATCH');
  await assert.rejects(slots.activate('missing'), (error) => error.code === 'STAGING_ARTIFACT_NOT_FOUND');
  await assert.rejects(slots.rollback(), (error) => error.code === 'STAGING_PREVIOUS_NOT_FOUND');
  await assert.rejects(slots.install({ version: '../escape', contents: 'contents' }), (error) => error.code === 'STAGING_ARTIFACT_INVALID');
  await assert.rejects(slots.install({ version: '..', contents: 'contents' }), (error) => error.code === 'STAGING_ARTIFACT_INVALID');
});
