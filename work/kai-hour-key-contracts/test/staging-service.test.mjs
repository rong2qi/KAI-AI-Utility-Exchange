import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStagingServer } from '../src/staging-service.mjs';

const digestV1 = 'e29d8ca58e821c8111b79d9beb8933f36225a1ae7384a58cc55f596a774dc25e';
const digestV2 = '242d7d4306b4d6694f1f67e275bc44a7717b2441fc05c8ca6655df2a14d4f6dc';

async function withServer(options, run) {
  const service = createStagingServer({ port: 0, ...options });
  await service.listen();
  try {
    return await run(service.address());
  } finally {
    await service.close();
  }
}

test('staging service reports its running version and digest', async () => {
  await withServer({ version: 'v1', digest: digestV1 }, async (address) => {
    const health = await fetch(`${address}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', version: 'v1', digest: digestV1 });

    const version = await fetch(`${address}/version`);
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { version: 'v1', digest: digestV1 });
  });
});

test('staging service exposes an unhealthy result without hiding the running version', async () => {
  await withServer({ version: 'v2', digest: digestV2, healthy: false }, async (address) => {
    const response = await fetch(`${address}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'failed',
      version: 'v2',
      digest: digestV2,
      reason: 'configured_unhealthy',
    });
  });
});

test('staging service keeps its boundary small and rejects unsupported requests', async () => {
  await withServer({ version: 'v1', digest: digestV1 }, async (address) => {
    const notFound = await fetch(`${address}/unknown`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'NOT_FOUND' });

    const method = await fetch(`${address}/healthz`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.deepEqual(await method.json(), { error: 'METHOD_NOT_ALLOWED' });
  });
});

test('staging service rejects a missing version or digest before listening', () => {
  assert.throws(() => createStagingServer({ version: '', digest: digestV1 }), (error) => error.code === 'STAGING_IDENTITY_INVALID');
  assert.throws(() => createStagingServer({ version: 'v1', digest: '' }), (error) => error.code === 'STAGING_IDENTITY_INVALID');
});

test('staging service rejects a non-local host, invalid port, or invalid timeout', () => {
  assert.throws(() => createStagingServer({ version: 'v1', digest: digestV1, host: '0.0.0.0' }), (error) => error.code === 'STAGING_HOST_INVALID');
  assert.throws(() => createStagingServer({ version: 'v1', digest: digestV1, port: 65_536 }), (error) => error.code === 'STAGING_PORT_INVALID');
  assert.throws(() => createStagingServer({ version: 'v1', digest: digestV1, requestTimeoutMs: 0 }), (error) => error.code === 'STAGING_TIMEOUT_INVALID');
});

test('staging service response contains only the release identity, never extra options', async () => {
  await withServer({ version: 'v1', digest: digestV1, secret: 'must-not-leak' }, async (address) => {
    const response = await fetch(`${address}/version`);
    const body = await response.text();
    assert.equal(body.includes('must-not-leak'), false);
    assert.deepEqual(JSON.parse(body), { version: 'v1', digest: digestV1 });
  });
});

test('staging service rejects unsafe versions and non-sha256 identities', () => {
  assert.throws(() => createStagingServer({ version: '.', digest: digestV1 }), (error) => error.code === 'STAGING_IDENTITY_INVALID');
  assert.throws(() => createStagingServer({ version: 'v1\nsecret', digest: digestV1 }), (error) => error.code === 'STAGING_IDENTITY_INVALID');
  assert.throws(() => createStagingServer({ version: 'v1', digest: 'digest-v1' }), (error) => error.code === 'STAGING_IDENTITY_INVALID');
});
