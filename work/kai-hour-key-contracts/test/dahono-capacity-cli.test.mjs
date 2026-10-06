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

test('confirmed CLI still requires a booking receipt identity without exposing it or reading credentials', () => {
  const entry = fileURLToPath(new URL('../scripts/dahono-capacity-verify.mjs', import.meta.url));
  const start = Date.now() - 1000;
  const env = { ...process.env, DAHONO_API_KEY: 'private-sentinel-key',
    DAHONO_WINDOW_START: new Date(start).toISOString(), DAHONO_WINDOW_END: new Date(start + 3600000).toISOString(),
  };
  delete env.GITHUB_RUN_ID;
  delete env.GITHUB_RUN_ATTEMPT;
  delete env.DAHONO_BOOKING_SLOT_ID;
  const run = spawnSync(process.execPath, [entry, '--confirm-live'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 2);
  const pointer = JSON.parse(readFileSync(new URL('../evidence/dahono-capacity/LATEST.json', import.meta.url)));
  const evidence = JSON.parse(readFileSync(new URL(`../${pointer.latestEvidenceFile}`, import.meta.url)));
  assert.equal(evidence.reason, 'BOOKING_IDENTITY_REQUIRED');
  assert.equal(evidence.scope.networkAttempted, false);
  assert.equal(evidence.scope.credentialResolved, false);
  assert.equal((run.stdout + run.stderr + JSON.stringify(evidence)).includes(env.DAHONO_API_KEY), false);
  assert.ok(evidence.source.files.includes('src/dahono-capacity-assessment.mjs'));
});
