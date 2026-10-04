#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStagingServer } from '../src/staging-service.mjs';

const manifestPath = resolve(process.env.KAI_STAGING_MANIFEST || 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {};
const version = process.env.KAI_RELEASE_VERSION || manifest.version;
const digest = process.env.KAI_RELEASE_DIGEST || manifest.digest;
const service = createStagingServer({
  version,
  digest,
  port: process.env.KAI_STAGING_PORT,
  healthy: process.env.KAI_STAGING_UNHEALTHY !== '1',
});

await service.listen();
process.stdout.write(`staging service listening on ${service.address()}\n`);

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
