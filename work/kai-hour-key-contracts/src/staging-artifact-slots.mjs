import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JsonAtomicFile } from './adapters/json-atomic-file.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const versionPattern = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class StagingArtifactSlotsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingArtifactSlotsError';
    this.code = code;
  }
}

const digestContents = (contents) => {
  if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) {
    throw new StagingArtifactSlotsError('STAGING_ARTIFACT_CONTENTS_INVALID', 'Artifact contents must be a string or Buffer');
  }
  return createHash('sha256').update(contents).digest('hex');
};

const validateArtifact = (artifact) => {
  if (!isPlainObject(artifact) || typeof artifact.version !== 'string' || !versionPattern.test(artifact.version) || artifact.version === '.' || artifact.version === '..') {
    throw new StagingArtifactSlotsError('STAGING_ARTIFACT_INVALID', 'Artifact version must be a safe non-empty identifier');
  }
  const digest = digestContents(artifact.contents);
  if (artifact.digest !== undefined && artifact.digest !== digest) {
    throw new StagingArtifactSlotsError('STAGING_ARTIFACT_DIGEST_MISMATCH', 'Artifact digest does not match its contents');
  }
  return { version: artifact.version, digest, contents: artifact.contents };
};

const writeJson = async (path, value) => {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

/** Two-slot local release store: immutable release directories plus current/previous metadata. */
export class StagingArtifactSlots {
  constructor({ root } = {}) {
    if (typeof root !== 'string' || root.trim() === '') throw new StagingArtifactSlotsError('STAGING_ROOT_REQUIRED', 'Staging artifact root is required');
    this.root = resolve(root);
    this.releasesRoot = join(this.root, 'releases');
    this.state = new JsonAtomicFile({ filePath: join(this.root, 'slots.json') });
  }

  async install(input) {
    const artifact = validateArtifact(input);
    await mkdir(this.releasesRoot, { recursive: true });
    const releaseRoot = join(this.releasesRoot, artifact.version);
    const manifestPath = join(releaseRoot, 'manifest.json');
    try {
      const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (existing.version !== artifact.version || existing.digest !== artifact.digest) throw new StagingArtifactSlotsError('STAGING_ARTIFACT_CONFLICT', 'Artifact version already has a different immutable digest');
      return { version: existing.version, digest: existing.digest };
    } catch (error) {
      if (error instanceof StagingArtifactSlotsError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(join(releaseRoot, 'artifact.bin'), artifact.contents, { flag: 'wx' }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await writeJson(manifestPath, { version: artifact.version, digest: artifact.digest });
    await this.state.transact((state) => ({
      state: { ...state, releases: { ...(state.releases || {}), [artifact.version]: { version: artifact.version, digest: artifact.digest } } },
      result: { version: artifact.version, digest: artifact.digest },
    }), { current: null, previous: null, releases: {} });
    return { version: artifact.version, digest: artifact.digest };
  }

  async activate(version) {
    this.#validateVersion(version);
    const result = await this.state.transact((state) => {
      const release = state.releases?.[version];
      if (!release) throw new StagingArtifactSlotsError('STAGING_ARTIFACT_NOT_FOUND', 'Artifact version is not installed');
      if (state.current?.version === version) return { state, result: { status: 'activated', ...release } };
      return {
        state: { ...state, current: release, previous: state.current || null },
        result: { status: 'activated', ...release },
      };
    }, { current: null, previous: null, releases: {} });
    await this.#prune();
    return result;
  }

  async rollback() {
    const result = await this.state.transact((state) => {
      if (!state.previous) throw new StagingArtifactSlotsError('STAGING_PREVIOUS_NOT_FOUND', 'No previous artifact is available for rollback');
      return {
        state: { ...state, current: state.previous, previous: state.current || null },
        result: { status: 'rolled_back', ...state.previous },
      };
    }, { current: null, previous: null, releases: {} });
    await this.#prune();
    return result;
  }

  async read(version) {
    this.#validateVersion(version);
    const manifestPath = join(this.releasesRoot, version, 'manifest.json');
    const artifactPath = join(this.releasesRoot, version, 'artifact.bin');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StagingArtifactSlotsError('STAGING_ARTIFACT_NOT_FOUND', 'Artifact version is not installed');
      throw error;
    }
    const contents = await readFile(artifactPath);
    if (digestContents(contents) !== manifest.digest) throw new StagingArtifactSlotsError('STAGING_ARTIFACT_DIGEST_MISMATCH', 'Stored artifact no longer matches its manifest');
    return { version: manifest.version, contents: contents.toString() };
  }

  async snapshot() {
    const state = await this.state.read({ current: null, previous: null, releases: {} });
    return clone({
      current: state.current ? { ...state.current } : null,
      previous: state.previous ? { ...state.previous } : null,
      releases: state.releases || {},
    });
  }

  #validateVersion(version) {
    if (typeof version !== 'string' || !versionPattern.test(version) || version === '.' || version === '..') throw new StagingArtifactSlotsError('STAGING_ARTIFACT_INVALID', 'Artifact version must be a safe non-empty identifier');
  }

  async #prune() {
    await this.state.transact(async (state) => {
      const keep = new Set([state.current?.version, state.previous?.version].filter(Boolean));
      const releases = { ...(state.releases || {}) };
      for (const version of Object.keys(releases)) {
        if (!keep.has(version)) {
          await rm(join(this.releasesRoot, version), { recursive: true, force: true });
          delete releases[version];
        }
      }
      return { state: { ...state, releases }, result: null };
    }, { current: null, previous: null, releases: {} });
  }
}
