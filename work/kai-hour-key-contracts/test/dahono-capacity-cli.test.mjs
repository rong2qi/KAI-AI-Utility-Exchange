import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('capacity CLI requires confirmation and never prints supplied secret or unknown arguments', () => {
  const entry = fileURLToPath(new URL('../scripts/dahono-capacity-verify.mjs', import.meta.url));
  const env = { ...process.env, DAHONO_API_KEY: 'private-sentinel-key' };
  delete env.GITHUB_RUN_ID;
  delete env.GITHUB_RUN_ATTEMPT;
  for (const args of [[], ['--private-sentinel-key']]) {
    const run = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' });
    assert.equal(run.status, args.length ? 1 : 2);
    assert.equal((run.stdout + run.stderr).includes(env.DAHONO_API_KEY), false);
    const pointer = JSON.parse(readFileSync(new URL('../evidence/dahono-capacity/LATEST.json', import.meta.url)));
    const evidence = JSON.parse(readFileSync(new URL(`../${pointer.latestEvidenceFile}`, import.meta.url)));
    assert.equal(evidence.scope.networkAttempted, false);
    assert.equal(evidence.scope.credentialsUsed, false);
    assert.equal(JSON.stringify(evidence).includes(env.DAHONO_API_KEY), false);
  }
});
