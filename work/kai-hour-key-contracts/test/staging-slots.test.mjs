import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('current and previous are two references without silently deleting installed releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  for (const version of ['v1', 'v2', 'v3']) {
    await slots.install(artifact(version));
    await slots.activate(version);
  }

  const snapshot = await slots.snapshot();
  assert.equal(snapshot.current.version, 'v3');
  assert.equal(snapshot.previous.version, 'v2');
  assert.deepEqual(Object.keys(snapshot.releases).sort(), ['v1', 'v2', 'v3']);
  assert.deepEqual(await slots.read('v1'), artifact('v1'));
});

test('concurrent conflicting installs commit exactly one byte-identical artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const first = new StagingArtifactSlots({ root });
  const second = new StagingArtifactSlots({ root });
  const outcomes = await Promise.allSettled([
    first.install(artifact('v1', 'first')),
    second.install(artifact('v1', 'second')),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = outcomes.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'STAGING_ARTIFACT_CONFLICT');
  const winner = outcomes[0].status === 'fulfilled' ? 'first' : 'second';
  assert.deepEqual(await first.read('v1'), artifact('v1', winner));
  const manifest = JSON.parse(await readFile(join(root, 'releases/v1/manifest.json'), 'utf8'));
  assert.equal(manifest.digest, (await first.snapshot()).releases.v1.digest);
});

test('install never labels a pre-existing partial artifact with a different digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  await mkdir(join(root, 'releases/v1'), { recursive: true });
  await writeFile(join(root, 'releases/v1/artifact.bin'), 'original');
  const slots = new StagingArtifactSlots({ root });
  await assert.rejects(slots.install(artifact('v1', 'replacement')));
  assert.equal(await readFile(join(root, 'releases/v1/artifact.bin'), 'utf8'), 'original');
  await assert.rejects(readFile(join(root, 'releases/v1/manifest.json')), { code: 'ENOENT' });
});

test('activation and rollback reject tampered bytes without changing either slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await slots.install(artifact('v1'));
  await slots.activate('v1');
  await slots.install(artifact('v2'));
  const before = await slots.snapshot();
  await writeFile(join(root, 'releases/v2/artifact.bin'), 'tampered');
  await assert.rejects(slots.activate('v2'), { code: 'STAGING_ARTIFACT_DIGEST_MISMATCH' });
  assert.deepEqual(await slots.snapshot(), before);
  await writeFile(join(root, 'releases/v2/artifact.bin'), 'contents-v2');
  await slots.activate('v2');
  const beforeRollback = await slots.snapshot();
  await writeFile(join(root, 'releases/v1/artifact.bin'), 'tampered');
  await assert.rejects(slots.rollback(), { code: 'STAGING_ARTIFACT_DIGEST_MISMATCH' });
  assert.deepEqual(await slots.snapshot(), beforeRollback);
});

test('installing a candidate concurrently with activation preserves it for later review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  const other = new StagingArtifactSlots({ root });
  await slots.install(artifact('v1'));
  await slots.activate('v1');
  await slots.install(artifact('v2'));
  await slots.install(artifact('pending'));
  await Promise.all([slots.activate('v2'), other.install(artifact('candidate'))]);
  assert.deepEqual(await other.read('candidate'), artifact('candidate'));
  assert.deepEqual(await other.read('pending'), artifact('pending'));
  assert.equal((await slots.snapshot()).releases.candidate.version, 'candidate');
});

test('local artifact rehearsal accepts text only instead of corrupting binary round trips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await assert.rejects(slots.install(artifact('v1', Buffer.from([0xff, 0x00]))), { code: 'STAGING_ARTIFACT_CONTENTS_INVALID' });
});

test('safe version identifiers cannot collide with inherited JavaScript property names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
  const slots = new StagingArtifactSlots({ root });
  await slots.install(artifact('constructor'));
  await slots.activate('constructor');
  assert.deepEqual(await slots.read('constructor'), artifact('constructor'));
});

test('artifact paths reject symlinks without writing to an outside directory', async () => {
  for (const location of ['root', 'releases', 'release', 'artifact', 'manifest', 'state']) {
    const parent = await mkdtemp(join(tmpdir(), 'kai-staging-slots-'));
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const slots = new StagingArtifactSlots({ root });
    if (location === 'root') {
      await rm(root, { recursive: true });
      await symlink(outside, root);
    } else if (location === 'releases') {
      await symlink(outside, join(root, 'releases'));
    } else if (location === 'release') {
      await mkdir(join(root, 'releases'));
      await symlink(outside, join(root, 'releases/v1'));
    } else if (location === 'state') {
      await writeFile(join(outside, 'state'), '{}');
      await symlink(join(outside, 'state'), join(root, 'slots.json'));
    } else {
      await slots.install(artifact('v1'));
      const name = location === 'artifact' ? 'artifact.bin' : 'manifest.json';
      await writeFile(join(outside, name), await readFile(join(root, 'releases/v1', name)));
      await rm(join(root, 'releases/v1', name));
      await symlink(join(outside, name), join(root, 'releases/v1', name));
    }
    await assert.rejects(slots.install(artifact('v1')), { code: 'STAGING_PATH_UNSAFE' }, location);
    if (location === 'artifact') assert.equal(await readFile(join(outside, 'artifact.bin'), 'utf8'), 'contents-v1');
    else await assert.rejects(readFile(join(outside, 'artifact.bin')), { code: 'ENOENT' });
  }
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
