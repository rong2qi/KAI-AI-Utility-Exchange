const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LocalStagingTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalStagingTargetError';
    this.code = code;
  }
}

const normalizeArtifact = (artifact) => {
  if (!isPlainObject(artifact) || typeof artifact.version !== 'string' || artifact.version.trim() === '' || typeof artifact.digest !== 'string' || artifact.digest.trim() === '') {
    throw new LocalStagingTargetError('TARGET_ARTIFACT_INVALID', 'Staging target artifact requires a version and digest');
  }
  return { version: artifact.version, digest: artifact.digest };
};

/** Local target adapter for contract rehearsal. It never connects to a network. */
export class LocalStagingTarget {
  constructor({ targetId = 'local-dry-run', healthByVersion = {} } = {}) {
    this.targetId = targetId;
    this.healthByVersion = { ...healthByVersion };
    this.active = null;
    this.history = [];
    this.knownArtifacts = new Map();
  }

  async inspect() {
    return {
      targetId: this.targetId,
      networkDisabled: true,
      realStagingProof: false,
      active: clone(this.active),
    };
  }

  async activate(artifact) {
    const normalized = normalizeArtifact(artifact);
    this.knownArtifacts.set(normalized.version, normalized.digest);
    this.active = normalized;
    this.history.push({ action: 'activate', ...normalized });
    return { status: 'activated', ...normalized };
  }

  async healthCheck(artifact) {
    const normalized = normalizeArtifact(artifact);
    if (!this.active || this.active.version !== normalized.version || this.active.digest !== normalized.digest) {
      throw new LocalStagingTargetError('TARGET_VERSION_NOT_ACTIVE', 'Staging target does not have the requested artifact active');
    }
    if (this.healthByVersion[normalized.version] === 'failed') {
      return { status: 'failed', ...normalized, reason: 'configured_local_failure' };
    }
    return { status: 'passed', ...normalized };
  }

  async rollback(request) {
    const normalized = normalizeArtifact(request);
    const expectedDigest = this.knownArtifacts.get(normalized.version);
    if (!expectedDigest || expectedDigest !== normalized.digest) {
      throw new LocalStagingTargetError('TARGET_ROLLBACK_DIGEST_MISMATCH', 'Rollback artifact digest does not match a known artifact');
    }
    const reason = typeof request.reason === 'string' && request.reason.trim() !== '' ? request.reason : 'unspecified';
    this.active = normalized;
    this.history.push({ action: 'rollback', ...normalized, reason });
    return { status: 'rolled_back', ...normalized, reason };
  }

  snapshot() {
    return { active: clone(this.active), history: clone(this.history) };
  }
}
