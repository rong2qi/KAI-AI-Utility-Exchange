import { JsonAtomicFile } from './json-atomic-file.mjs';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const sameKey = (entry, accountId, idempotencyKey) => entry.accountId === accountId && entry.idempotencyKey === idempotencyKey;

/** Restart-readable local ledger store; production uses a transactional ledger table. */
export class JsonUsageExecutionLedgerStore {
  constructor(options = {}) {
    this.file = new JsonAtomicFile(options);
  }

  async get(accountId, idempotencyKey) {
    let entries;
    try {
      entries = await this.file.read([]);
    } catch {
      throw new Error('EXECUTION_LEDGER_CORRUPT');
    }
    if (!Array.isArray(entries)) throw new Error('EXECUTION_LEDGER_CORRUPT');
    const entry = entries.find((item) => sameKey(item, accountId, idempotencyKey));
    return clone(entry);
  }

  async save(entry) {
    try {
      return await this.file.transact(async (entries) => {
        if (!Array.isArray(entries)) throw new Error('EXECUTION_LEDGER_CORRUPT');
        const index = entries.findIndex((item) => sameKey(item, entry.accountId, entry.idempotencyKey));
        if (index < 0) {
          return { state: [...entries, clone(entry)], result: clone(entry) };
        }
        if (entries[index].requestHash !== entry.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
        const next = entries.slice();
        next[index] = clone(entry);
        return { state: next, result: clone(entry) };
      }, []);
    } catch (error) {
      if (['IDEMPOTENCY_CONFLICT', 'EXECUTION_LEDGER_CORRUPT'].includes(error?.message)) throw error;
      if (error?.message === 'JSON_STATE_BUSY') throw new Error('EXECUTION_LEDGER_BUSY', { cause: error });
      throw new Error('EXECUTION_LEDGER_UNAVAILABLE', { cause: error });
    }
  }
}
