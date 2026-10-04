import { createHash } from 'node:crypto';
import { toUserFacingReleaseResult, userRetryResult } from './release-user-result.mjs';

export { toUserFacingReleaseResult } from './release-user-result.mjs';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

export class StagingRehearsalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingRehearsalError';
    this.code = code;
  }
}

export const artifactDigest = (contents) => {
  if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) {
    throw new StagingRehearsalError('ARTIFACT_CONTENTS_INVALID', 'Artifact contents must be a string or Buffer');
  }
  return createHash('sha256').update(contents).digest('hex');
};

const requiredManifestFields = [
  'version',
  'sourceCommit',
  'sourceFingerprint',
  'packageLockSha256',
  'nodeRange',
  'providerModel',
  'artifactSha256',
  'createdAt',
];

export const normalizeArtifactManifest = (input) => {
  if (!isPlainObject(input)) throw new StagingRehearsalError('ARTIFACT_MANIFEST_REQUIRED', 'Artifact manifest is required');
  for (const field of requiredManifestFields) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new StagingRehearsalError('ARTIFACT_MANIFEST_FIELD_REQUIRED', `Artifact manifest field ${field} is required`);
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new StagingRehearsalError('ARTIFACT_MANIFEST_SOURCE_COMMIT_INVALID', 'Artifact sourceCommit must be a 40-character hexadecimal commit');
  }
  for (const field of ['sourceFingerprint', 'packageLockSha256', 'artifactSha256']) {
    if (!/^[0-9a-f]{64}$/i.test(input[field])) {
      throw new StagingRehearsalError('ARTIFACT_MANIFEST_DIGEST_INVALID', `Artifact manifest field ${field} must be a 64-character hexadecimal digest`);
    }
  }
  return Object.freeze(Object.fromEntries(requiredManifestFields.map((field) => [field, input[field]])));
};

const normalizeHealthChecks = (checks) => {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new StagingRehearsalError('HEALTH_CHECKS_REQUIRED', 'At least one release health check is required');
  }
  return checks.map((check) => {
    if (!isPlainObject(check) || typeof check.name !== 'string' || check.name.trim() === '') {
      throw new StagingRehearsalError('HEALTH_CHECK_INVALID', 'Health check name is required');
    }
    if (!['passed', 'warning', 'failed'].includes(check.status)) {
      throw new StagingRehearsalError('HEALTH_CHECK_STATUS_INVALID', `Health check ${check.name} has an invalid status`);
    }
    return {
      name: check.name,
      status: check.status,
      required: check.required !== false,
      ...(check.detail ? { detail: String(check.detail) } : {}),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
};

export const evaluateHealthGate = ({ manifest, checks, previousKnownGood } = {}) => {
  const normalizedManifest = normalizeArtifactManifest(manifest);
  const normalizedChecks = normalizeHealthChecks(checks);
  const previousDigest = previousKnownGood?.digest || null;
  const gateId = createHash('sha256').update(canonicalJson({
    manifest: normalizedManifest,
    checks: normalizedChecks,
    previousDigest,
  })).digest('hex');
  const failedRequired = normalizedChecks.filter((check) => check.required && check.status !== 'passed');
  if (failedRequired.length === 0) {
    return {
      decision: 'activate',
      reasonCode: null,
      gateId,
      manifest: normalizedManifest,
      checks: normalizedChecks,
    };
  }
  if (!previousKnownGood?.version || !previousKnownGood?.digest) {
    return {
      decision: 'blocked',
      reasonCode: 'NO_VERIFIED_PREVIOUS_ARTIFACT',
      gateId,
      manifest: normalizedManifest,
      checks: normalizedChecks,
    };
  }
  return {
    decision: 'rollback',
    reasonCode: 'REQUIRED_HEALTH_CHECK_FAILED',
    gateId,
    manifest: normalizedManifest,
    checks: normalizedChecks,
  };
};

/** Monotonic lease used to reject writes from a superseded staging worker. */
export class StagingFence {
  constructor() {
    this.epoch = 0;
    this.current = undefined;
  }

  acquire(workerId) {
    if (!workerId) throw new StagingRehearsalError('WORKER_ID_REQUIRED', 'Staging worker ID is required');
    this.epoch += 1;
    this.current = Object.freeze({ workerId, epoch: this.epoch });
    return this.current;
  }

  assertCurrent(token) {
    if (!token || !this.current || token.epoch !== this.current.epoch || token.workerId !== this.current.workerId) {
      throw new StagingRehearsalError('STALE_FENCE_TOKEN', 'Staging worker no longer owns the write fence');
    }
  }
}

/**
 * Small transactional seam for staging rehearsal. It models an atomic row
 * transaction and fencing without pretending to be a production database.
 */
export class StagingTransactionalStore {
  constructor({ fence, initial = {} } = {}) {
    if (!fence) throw new StagingRehearsalError('FENCE_REQUIRED', 'Staging transaction fence is required');
    this.fence = fence;
    this.state = clone(initial);
    this.version = 0;
    this.queue = Promise.resolve();
  }

  snapshot() {
    return clone(this.state);
  }

  async transact(token, mutator) {
    this.fence.assertCurrent(token);
    if (typeof mutator !== 'function') throw new StagingRehearsalError('TRANSACTION_MUTATOR_REQUIRED', 'Staging transaction mutator is required');
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      this.fence.assertCurrent(token);
      const baseVersion = this.version;
      const draft = clone(this.state);
      const result = await mutator(draft);
      this.fence.assertCurrent(token);
      if (baseVersion !== this.version) throw new StagingRehearsalError('TRANSACTION_CONFLICT', 'Staging transaction version changed before commit');
      this.state = draft;
      this.version += 1;
      return clone(result);
    } finally {
      release();
    }
  }
}

/** Immutable artifact manifest plus fenced activation and rollback. */
export class StagingArtifactRegistry {
  constructor({ fence, store } = {}) {
    this.fence = fence || new StagingFence();
    const selectedStore = store || new StagingTransactionalStore({
      fence: this.fence,
      initial: { artifacts: {}, activeVersion: null, history: [] },
    });
    if (typeof selectedStore.snapshot !== 'function' || typeof selectedStore.transact !== 'function') {
      throw new StagingRehearsalError('TRANSACTION_STORE_REQUIRED', 'Staging artifact registry requires a transactional store port');
    }
    this.store = selectedStore;
  }

  async publish({ version, contents, digest, manifest }, token) {
    if (!version || contents === undefined) throw new StagingRehearsalError('ARTIFACT_INPUT_INVALID', 'Artifact version and contents are required');
    const normalizedManifest = normalizeArtifactManifest(manifest);
    if (normalizedManifest.version !== version) throw new StagingRehearsalError('ARTIFACT_MANIFEST_VERSION_MISMATCH', 'Artifact manifest version does not match the publish version');
    const computedDigest = artifactDigest(contents);
    if (digest && digest !== computedDigest) throw new StagingRehearsalError('ARTIFACT_DIGEST_MISMATCH', 'Artifact digest does not match its contents');
    if (normalizedManifest.artifactSha256 !== computedDigest) throw new StagingRehearsalError('ARTIFACT_MANIFEST_DIGEST_MISMATCH', 'Artifact manifest digest does not match its contents');
    return this.store.transact(token, (draft) => {
      const existing = draft.artifacts[version];
      if (existing && (existing.digest !== computedDigest || canonicalJson(existing.manifest) !== canonicalJson(normalizedManifest))) {
        throw new StagingRehearsalError('ARTIFACT_VERSION_CONFLICT', 'Artifact version already has a different immutable identity');
      }
      draft.artifacts[version] = { version, digest: computedDigest, manifest: normalizedManifest };
      return draft.artifacts[version];
    });
  }

  async activate({ version, digest, gateId, result }, token) {
    return this.#setActive({ action: 'activate', version, digest, reason: null, gateId, result }, token);
  }

  async rollback({ version, digest, reason, gateId, result }, token) {
    return this.#setActive({ action: 'rollback', version, digest, reason: reason || 'unspecified', gateId, result }, token);
  }

  snapshot() {
    return this.store.snapshot();
  }

  getArtifact(version) {
    return clone(this.store.snapshot().artifacts[version]);
  }

  findGate(gateId) {
    return clone(this.store.snapshot().history.find((event) => event.gateId === gateId));
  }

  async #setActive({ action, version, digest, reason, gateId, result }, token) {
    return this.store.transact(token, (draft) => {
      const artifact = draft.artifacts[version];
      if (!artifact) throw new StagingRehearsalError('ARTIFACT_NOT_FOUND', 'Artifact version is not published');
      if (!digest || artifact.digest !== digest) throw new StagingRehearsalError('ARTIFACT_DIGEST_MISMATCH', 'Activation digest does not match the published artifact');
      draft.activeVersion = version;
      draft.history.push({ action, version, digest, reason, ...(gateId ? { gateId } : {}), ...(result ? { result: clone(result) } : {}) });
      return { version, digest, action };
    });
  }
}

/** Local release gate. It is deterministic and deliberately does not deploy to an external platform. */
export class StagingDeploymentController {
  constructor({ registry } = {}) {
    if (!registry) throw new StagingRehearsalError('REGISTRY_REQUIRED', 'Staging deployment registry is required');
    this.registry = registry;
    this.results = new Map();
  }

  async release({ manifest, checks, token } = {}) {
    const normalizedManifest = normalizeArtifactManifest(manifest);
    const normalizedChecks = normalizeHealthChecks(checks);
    const snapshot = this.registry.snapshot();
    const previousKnownGood = snapshot.activeVersion ? this.registry.getArtifact(snapshot.activeVersion) : null;
    // Once this exact candidate is active, a repeated request is the same gate
    // and must not acquire a new identity merely because the active digest changed.
    const gatePrevious = snapshot.activeVersion === normalizedManifest.version ? null : previousKnownGood;
    const gate = evaluateHealthGate({ manifest: normalizedManifest, checks: normalizedChecks, previousKnownGood: gatePrevious });
    const cached = this.results.get(gate.gateId) || this.registry.findGate(gate.gateId)?.result;
    if (cached) return clone(cached);
    const candidate = this.registry.getArtifact(normalizedManifest.version);
    if (!candidate || canonicalJson(candidate.manifest) !== canonicalJson(normalizedManifest) || candidate.digest !== normalizedManifest.artifactSha256) {
      const blocked = { decision: 'blocked', reasonCode: 'MANIFEST_MISMATCH', gateId: gate.gateId, manifest: normalizedManifest, checks: normalizedChecks };
      this.results.set(gate.gateId, blocked);
      return clone(blocked);
    }
    if (gate.decision === 'blocked') {
      const blocked = { ...gate };
      this.results.set(gate.gateId, blocked);
      return clone(blocked);
    }
    if (gate.decision === 'rollback') {
      const result = { ...gate, rollbackTo: { version: previousKnownGood.version, digest: previousKnownGood.digest } };
      await this.registry.rollback({
        version: previousKnownGood.version,
        digest: previousKnownGood.digest,
        reason: gate.reasonCode,
        gateId: gate.gateId,
        result,
      }, token);
      this.results.set(gate.gateId, result);
      return clone(result);
    }
    const result = { ...gate, version: candidate.version, digest: candidate.digest };
    await this.registry.activate({ version: candidate.version, digest: candidate.digest, gateId: gate.gateId, result }, token);
    this.results.set(gate.gateId, result);
    return clone(result);
  }

  async previewForUser(input = {}) {
    try {
      const normalizedManifest = normalizeArtifactManifest(input.manifest);
      const normalizedChecks = normalizeHealthChecks(input.checks);
      const snapshot = this.registry.snapshot();
      const previousKnownGood = snapshot.activeVersion ? this.registry.getArtifact(snapshot.activeVersion) : null;
      const gatePrevious = snapshot.activeVersion === normalizedManifest.version ? null : previousKnownGood;
      const gate = evaluateHealthGate({ manifest: normalizedManifest, checks: normalizedChecks, previousKnownGood: gatePrevious });
      const candidate = this.registry.getArtifact(normalizedManifest.version);
      if (!candidate || canonicalJson(candidate.manifest) !== canonicalJson(normalizedManifest) || candidate.digest !== normalizedManifest.artifactSha256) {
        return toUserFacingReleaseResult({ decision: 'blocked', reasonCode: 'MANIFEST_MISMATCH' });
      }
      if (gate.decision === 'activate') return toUserFacingReleaseResult({ decision: 'ready', version: candidate.version });
      return toUserFacingReleaseResult(gate);
    } catch {
      return userRetryResult();
    }
  }

  async releaseForUser(input = {}) {
    try {
      return toUserFacingReleaseResult(await this.release(input));
    } catch {
      return userRetryResult();
    }
  }
}
