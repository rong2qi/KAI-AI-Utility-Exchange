#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const version = option('--version');
const output = resolve(option('--output') || join(packageRoot, 'evidence/staging-bundle/staging.tar.gz'));
const versionPattern = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;
if (typeof version !== 'string' || !versionPattern.test(version) || version === '.' || version === '..') {
  throw new Error('STAGING_BUNDLE_VERSION_INVALID');
}
if (!isAbsolute(output)) throw new Error('STAGING_BUNDLE_OUTPUT_INVALID');
if (basename(output) !== 'staging.tar.gz') throw new Error('STAGING_BUNDLE_OUTPUT_INVALID');

const result = spawnSync('tar', [
  '-czf', output,
  '-C', packageRoot,
  'src/staging-service.mjs',
  'scripts/staging-service.mjs',
], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`STAGING_BUNDLE_TAR_FAILED: ${result.stderr || result.error || 'unknown error'}`);
const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
const evidence = {
  schemaVersion: 'kai-staging-bundle.v1',
  version,
  digest,
  bytes: statSync(output).size,
  archive: output,
  files: ['src/staging-service.mjs', 'scripts/staging-service.mjs'],
  installPolicy: 'server writes manifest after verifying the archive digest; no npm install or postinstall runs on target',
};
writeFileSync(`${output}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
