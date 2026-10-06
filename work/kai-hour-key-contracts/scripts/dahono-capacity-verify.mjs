#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDahonoCapacityAcceptance } from '../src/dahono-capacity-acceptance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const offlineFailure = (reason) => ({
  status: 'failed', reason,
  scope: { networkAttempted: false, credentialsUsed: false },
});
let result;
if (args.some((arg) => arg !== '--confirm-live') || args.length > 1) {
  result = offlineFailure('UNKNOWN_ARGUMENT');
} else {
  try {
    result = await runDahonoCapacityAcceptance({
      confirmLive: args.includes('--confirm-live'),
      windowStart: process.env.DAHONO_WINDOW_START,
      windowEnd: process.env.DAHONO_WINDOW_END,
      apiKeyResolver: () => process.env.DAHONO_API_KEY,
    });
  } catch {
    // Unexpected orchestration errors cannot certify whether a request escaped.
    result = { status: 'failed', reason: 'ACCEPTANCE_INTERNAL_ERROR', scope: { networkAttempted: null, credentialsUsed: null } };
  }
}
const files = [
  'src/dahono-capacity-acceptance.mjs',
  'src/adapters/dahono-router-provider.mjs',
  'scripts/dahono-capacity-verify.mjs',
  'package-lock.json',
];
const fingerprint = createHash('sha256');
for (const file of files) fingerprint.update(file + '\0').update(readFileSync(join(root, file)));
const git = (...commands) => spawnSync('git', commands, { cwd: root, encoding: 'utf8' });
const revision = git('rev-parse', 'HEAD');
const changes = git('status', '--porcelain', '--untracked-files=all');
const runId = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '1')
  ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${args.includes('--confirm-live') ? 'live' : 'guard'}`
  : `local-${randomUUID()}`;
const evidence = {
  ...result,
  schemaVersion: 'kai-dahono-capacity-run.v1',
  runId,
  recordedAt: new Date().toISOString(),
  source: {
    commit: revision.status === 0 ? revision.stdout.trim() : null,
    workingTreeDirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null,
    sha256: fingerprint.digest('hex'),
    files, nodeVersion: process.version,
  },
};
const directory = join(root, 'evidence/dahono-capacity');
mkdirSync(directory, { recursive: true });
const file = join(directory, `${runId}.json`);
writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(directory, 'LATEST.json'), `${JSON.stringify({
  schemaVersion: 'kai-dahono-capacity-pointer.v1',
  latestEvidenceFile: relative(root, file), status: evidence.status,
}, null, 2)}\n`, { mode: 0o600 });
console.log(`dahono_capacity=${evidence.status} evidence=${relative(root, file)}`);
process.exitCode = evidence.status === 'passed' ? 0 : evidence.status === 'failed' ? 1 : 2;
