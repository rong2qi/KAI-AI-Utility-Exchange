import { createHash } from 'node:crypto';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export class StagingRehearsalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingRehearsalError';
    this.code = code;
  }
}

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

const digestOf = (contents) => createHash('sha256').update(contents).digest('hex');

/** Immutable artifact manifest plus fenced activation and rollback. */
export class StagingArtifactRegistry {
  constructor({ fence, store } = {}) {
    this.fence = fence || new StagingFence();
    this.store = store || new StagingTransactionalStore({
      fence: this.fence,
      initial: { artifacts: {}, activeVersion: null, history: [] },
    });
  }

  async publish({ version, contents, digest }, token) {
    if (!version || contents === undefined) throw new StagingRehearsalError('ARTIFACT_INPUT_INVALID', 'Artifact version and contents are required');
    const computedDigest = digestOf(contents);
    if (digest && digest !== computedDigest) throw new StagingRehearsalError('ARTIFACT_DIGEST_MISMATCH', 'Artifact digest does not match its contents');
    return this.store.transact(token, (draft) => {
      const existing = draft.artifacts[version];
      if (existing && existing.digest !== computedDigest) throw new StagingRehearsalError('ARTIFACT_VERSION_CONFLICT', 'Artifact version already has a different digest');
      draft.artifacts[version] = { version, digest: computedDigest };
      return draft.artifacts[version];
    });
  }

  async activate({ version, digest }, token) {
    return this.#setActive({ action: 'activate', version, digest, reason: null }, token);
  }

  async rollback({ version, digest, reason }, token) {
    return this.#setActive({ action: 'rollback', version, digest, reason: reason || 'unspecified' }, token);
  }

  snapshot() {
    return this.store.snapshot();
  }

  async #setActive({ action, version, digest, reason }, token) {
    return this.store.transact(token, (draft) => {
      const artifact = draft.artifacts[version];
      if (!artifact) throw new StagingRehearsalError('ARTIFACT_NOT_FOUND', 'Artifact version is not published');
      if (!digest || artifact.digest !== digest) throw new StagingRehearsalError('ARTIFACT_DIGEST_MISMATCH', 'Activation digest does not match the published artifact');
      draft.activeVersion = version;
      draft.history.push({ action, version, digest, reason });
      return { version, digest, action };
    });
  }
}
