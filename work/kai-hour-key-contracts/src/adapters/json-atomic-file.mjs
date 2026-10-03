import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Shared local persistence primitive: exclusive lock plus atomic JSON replacement. */
export class JsonAtomicFile {
  constructor({ filePath, lockTimeoutMs = 2000, retryDelayMs = 5 } = {}) {
    if (!filePath) throw new Error('JSON_STATE_PATH_REQUIRED');
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryDelayMs = retryDelayMs;
  }

  async read(defaultValue) {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultValue;
      throw new Error('JSON_STATE_CORRUPT', { cause: error });
    }
  }

  async #acquireLock() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        return await open(this.lockPath, 'wx');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new Error('JSON_STATE_LOCK_FAILED', { cause: error });
        if (Date.now() >= deadline) throw new Error('JSON_STATE_BUSY', { cause: error });
        await sleep(this.retryDelayMs);
      }
    }
  }

  async #write(value) {
    const temporaryPath = this.filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      const handle = await open(temporaryPath, 'r+');
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async transact(mutator, defaultValue) {
    const lockHandle = await this.#acquireLock();
    try {
      const current = await this.read(defaultValue);
      const outcome = await mutator(current);
      await this.#write(outcome.state);
      return outcome.result;
    } finally {
      await lockHandle.close();
      await unlink(this.lockPath).catch(() => {});
    }
  }
}
