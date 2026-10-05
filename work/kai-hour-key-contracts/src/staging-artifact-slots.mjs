import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { JsonAtomicFile } from './adapters/json-atomic-file.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const versionPattern = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;
const emptyState = () => ({ current: null, previous: null, releases: {} });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const digestContents = (contents) => createHash('sha256').update(contents).digest('hex');

export class StagingArtifactSlotsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingArtifactSlotsError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new StagingArtifactSlotsError(code, message); };
const validateVersion = (version) => {
  if (typeof version !== 'string' || !versionPattern.test(version) || version === '.' || version === '..') {
    fail('STAGING_ARTIFACT_INVALID', 'Artifact version must be a safe non-empty identifier');
  }
};

const validateArtifact = (artifact) => {
  validateVersion(artifact?.version);
  if (typeof artifact.contents !== 'string') {
    fail('STAGING_ARTIFACT_CONTENTS_INVALID', 'Local rehearsal artifacts must be text');
  }
  const digest = digestContents(artifact.contents);
  if (artifact.digest !== undefined && artifact.digest !== digest) {
    fail('STAGING_ARTIFACT_DIGEST_MISMATCH', 'Artifact digest does not match its contents');
  }
  return { version: artifact.version, digest, contents: artifact.contents };
};

/**
 * Local text-artifact rehearsal, not the privileged deployment helper.
 * Current/previous are two activation references. Installed candidates and older
 * releases remain available; health-aware retention belongs to the deployer.
 * The root must be private to this process/user: this is not a sandbox against
 * another writer replacing directories while an operation is running.
 */
export class StagingArtifactSlots {
  constructor({ root } = {}) {
    if (typeof root !== 'string' || root.trim() === '') fail('STAGING_ROOT_REQUIRED', 'Staging artifact root is required');
    this.root = resolve(root);
    this.releasesRoot = join(this.root, 'releases');
    this.state = new JsonAtomicFile({ filePath: join(this.root, 'slots.json') });
  }

  async #checkPath(path, type) {
    const nested = relative(this.root, path);
    if (nested === '..' || nested.startsWith(`..${sep}`)) fail('STAGING_PATH_UNSAFE', 'Artifact path escapes the staging root');
    let current = this.root;
    for (const part of ['', ...nested.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      let entry;
      try { entry = await lstat(current); } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      if (entry.isSymbolicLink() || (current !== path && !entry.isDirectory())) {
        fail('STAGING_PATH_UNSAFE', 'Staging paths must not contain symbolic links');
      }
      if (current === path && !(type === 'directory' ? entry.isDirectory() : entry.isFile())) {
        fail('STAGING_PATH_UNSAFE', 'Staging path has the wrong file type');
      }
    }
    return true;
  }

  async #transaction(mutator) {
    await this.#checkPath(this.root, 'directory');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#checkPath(this.root, 'directory');
    // The absolute canonical root is stable across macOS /var and /tmp aliases.
    const canonicalRoot = await realpath(this.root);
    for (const path of [this.state.filePath, this.state.lockPath]) await this.#checkPath(path, 'file');
    return this.state.transact(async (state) => {
      if (await realpath(this.root) !== canonicalRoot) fail('STAGING_PATH_UNSAFE', 'Staging root changed during the operation');
      await this.#checkPath(this.state.filePath, 'file');
      await this.#checkPath(this.releasesRoot, 'directory');
      return mutator(state);
    }, emptyState());
  }

  async #readRelease(version, expected) {
    validateVersion(version);
    const releaseRoot = join(this.releasesRoot, version);
    const manifestPath = join(releaseRoot, 'manifest.json');
    const artifactPath = join(releaseRoot, 'artifact.bin');
    const readSafe = async (path) => {
      if (!await this.#checkPath(path, 'file')) fail('STAGING_ARTIFACT_NOT_FOUND', 'Artifact version is not fully installed');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return await handle.readFile(); } finally { await handle.close(); }
    };
    const manifest = JSON.parse((await readSafe(manifestPath)).toString('utf8'));
    const contents = await readSafe(artifactPath);
    if (manifest.version !== version || digestContents(contents) !== manifest.digest
      || (expected && (manifest.digest !== expected.digest || manifest.version !== expected.version))) {
      fail('STAGING_ARTIFACT_DIGEST_MISMATCH', 'Stored artifact does not match its registered identity');
    }
    return { version, digest: manifest.digest, contents: contents.toString('utf8') };
  }

  async install(input) {
    const artifact = validateArtifact(input);
    return this.#transaction(async (state) => {
      const releaseRoot = join(this.releasesRoot, artifact.version);
      const release = { version: artifact.version, digest: artifact.digest };
      const registered = own(state.releases, artifact.version) ? state.releases[artifact.version] : null;
      if (registered && registered.digest !== artifact.digest) {
        fail('STAGING_ARTIFACT_CONFLICT', 'Artifact version already has a different immutable digest');
      }
      if (await this.#checkPath(releaseRoot, 'directory')) {
        const existing = await this.#readRelease(artifact.version, registered);
        if (existing.digest !== artifact.digest) fail('STAGING_ARTIFACT_CONFLICT', 'Artifact version already has a different immutable digest');
      } else {
        await mkdir(this.releasesRoot, { recursive: true, mode: 0o700 });
        await this.#checkPath(this.releasesRoot, 'directory');
        // Exclusive creation: a partial release is never overwritten or relabeled.
        await mkdir(releaseRoot, { mode: 0o700 });
        await writeFile(join(releaseRoot, 'artifact.bin'), artifact.contents, { flag: 'wx', mode: 0o600 });
        await writeFile(join(releaseRoot, 'manifest.json'), `${JSON.stringify(release)}\n`, { flag: 'wx', mode: 0o600 });
      }
      return { state: { ...state, releases: { ...(state.releases || {}), [artifact.version]: release } }, result: release };
    });
  }

  async activate(version) {
    validateVersion(version);
    return this.#transaction(async (state) => {
      const release = own(state.releases, version) ? state.releases[version] : null;
      if (!release) fail('STAGING_ARTIFACT_NOT_FOUND', 'Artifact version is not installed');
      await this.#readRelease(version, release);
      if (state.current?.version === version) return { state, result: { status: 'activated', ...release } };
      return {
        state: { ...state, current: release, previous: state.current || null },
        result: { status: 'activated', ...release },
      };
    });
  }

  async rollback() {
    return this.#transaction(async (state) => {
      if (!state.previous) fail('STAGING_PREVIOUS_NOT_FOUND', 'No previous artifact is available for rollback');
      await this.#readRelease(state.previous.version, state.previous);
      return {
        state: { ...state, current: state.previous, previous: state.current || null },
        result: { status: 'rolled_back', ...state.previous },
      };
    });
  }

  async read(version) {
    validateVersion(version);
    return this.#transaction(async (state) => {
      const release = own(state.releases, version) ? state.releases[version] : null;
      if (!release) fail('STAGING_ARTIFACT_NOT_FOUND', 'Artifact version is not installed');
      const { contents } = await this.#readRelease(version, release);
      return { state, result: { version, contents } };
    });
  }

  async snapshot() {
    return this.#transaction(async (state) => ({ state, result: clone({
      current: state.current || null,
      previous: state.previous || null,
      releases: state.releases || {},
    }) }));
  }
}
