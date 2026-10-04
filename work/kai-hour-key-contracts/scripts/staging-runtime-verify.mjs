#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagingArtifactSlots } from '../src/staging-artifact-slots.mjs';
import { createStagingServer } from '../src/staging-service.mjs';

const digestFor = (version) => ({
  v1: 'e29d8ca58e821c8111b79d9beb8933f36225a1ae7384a58cc55f596a774dc25e',
  v2: '242d7d4306b4d6694f1f67e275bc44a7717b2441fc05c8ca6655df2a14d4f6dc',
}[version]);

const root = await mkdtemp(join(tmpdir(), 'kai-staging-runtime-'));
const slots = new StagingArtifactSlots({ root });
let service;
let status = 'passed';
let error = null;
const scenarios = [];

try {
  await slots.install({ version: 'v1', contents: 'contents-v1', digest: digestFor('v1') });
  await slots.activate('v1');
  await slots.install({ version: 'v2', contents: 'contents-v2', digest: digestFor('v2') });
  await slots.activate('v2');
  const active = await slots.snapshot();
  service = createStagingServer({ version: active.current.version, digest: active.current.digest });
  await service.listen();
  const health = await fetch(`${service.address()}/healthz`);
  const version = await fetch(`${service.address()}/version`);
  scenarios.push({
    name: 'active_artifact_is_reported_by_runtime',
    active: active.current,
    previous: active.previous,
    health: { status: health.status, body: await health.json() },
    version: { status: version.status, body: await version.json() },
  });
  const rollback = await slots.rollback();
  scenarios.push({ name: 'rollback_restores_previous_artifact', result: rollback, slots: await slots.snapshot() });
} catch (caught) {
  status = 'failed';
  error = { name: caught.name, code: caught.code || null, message: caught.message };
} finally {
  if (service) await service.close();
  await rm(root, { recursive: true, force: true });
}

const evidence = {
  schemaVersion: 'kai-staging-runtime-evidence.v1',
  status,
  level: 'staging-runtime-rehearsal',
  scope: {
    networkDisabled: true,
    externalNetworkUsed: false,
    targetId: 'local-loopback-runtime',
    realStagingProof: false,
    productionProof: false,
  },
  scenarios,
  result: { error },
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (status !== 'passed') process.exitCode = 1;
