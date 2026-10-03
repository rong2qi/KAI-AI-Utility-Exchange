import { JsonAtomicFile } from './json-atomic-file.mjs';
import { copyOffer, marketFactsMatch } from '../offer-facts.mjs';

/**
 * Local durable store for packaging idempotency.
 *
 * It uses an exclusive lock file and atomic rename for one JSON state file.
 * Deployment stores should implement the same port with a database transaction
 * and a unique constraint on (accountId, idempotencyKey).
 */
export class JsonHourKeyPackagingStore {
  constructor(options = {}) {
    this.file = new JsonAtomicFile(options);
  }

  async get(accountId, idempotencyKey) {
    let records;
    try {
      records = await this.file.read([]);
    } catch {
      throw new Error('PACKAGING_STORE_CORRUPT');
    }
    if (!Array.isArray(records)) throw new Error('PACKAGING_STORE_CORRUPT');
    const record = records.find((item) => item.accountId === accountId && item.idempotencyKey === idempotencyKey);
    return record ? copyOffer(record.offer) : undefined;
  }

  async getOrCreate({ accountId, idempotencyKey, offer }) {
    try {
      return await this.file.transact(async (records) => {
        if (!Array.isArray(records)) throw new Error('PACKAGING_STORE_CORRUPT');
        const existing = records.find((item) => item.accountId === accountId && item.idempotencyKey === idempotencyKey);
        if (existing) {
          if (!marketFactsMatch(offer, existing.offer)) throw new Error('IDEMPOTENCY_CONFLICT');
          return { state: records, result: copyOffer(existing.offer) };
        }
        const stored = copyOffer(offer);
        return {
          state: [...records, { accountId, idempotencyKey, offer: stored }],
          result: copyOffer(stored),
        };
      }, []);
    } catch (error) {
      if (['IDEMPOTENCY_CONFLICT', 'PACKAGING_STORE_CORRUPT'].includes(error?.message)) throw error;
      if (error?.message === 'JSON_STATE_BUSY') throw new Error('PACKAGING_STORE_BUSY', { cause: error });
      throw new Error('PACKAGING_STORE_LOCK_FAILED', { cause: error });
    }
  }
}
