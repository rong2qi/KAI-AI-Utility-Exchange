import { copyOffer, marketFactsMatch } from '../offer-facts.mjs';

/**
 * Packages a current market Offer as a KAI Hour Key Offer.
 * Market facts are copied unchanged; only the KAI packaging state advances.
 * The injected store owns the durable atomic idempotency boundary.
 */
export class HourKeyPackagingAdapter {
  constructor({ store = new MemoryHourKeyPackagingStore() } = {}) { this.store = store; }

  async package({ accountId, offer, idempotencyKey }) {
    if (!accountId || !idempotencyKey || !offer?.offerId) throw new Error('PACKAGING_COMMAND_INVALID');
    if (offer.executionEligible !== true) throw new Error('OFFER_NOT_EXECUTION_ELIGIBLE');
    if (offer.availability === 'unavailable') throw new Error('OFFER_UNAVAILABLE');
    if (!['unpackaged', 'packaged'].includes(offer.hourKeyStatus)) throw new Error('HOUR_KEY_STATUS_INVALID');
    const packaged = { ...copyOffer(offer), hourKeyStatus: 'packaged' };
    const stored = await this.store.getOrCreate({ accountId, idempotencyKey, offer: packaged });
    if (!marketFactsMatch(packaged, stored) || stored.hourKeyStatus !== 'packaged') {
      throw new Error('PACKAGING_STORE_CORRUPT');
    }
    return copyOffer(stored);
  }
}

export class MemoryHourKeyPackagingStore {
  constructor(records = []) {
    this.records = new Map(records.map((record) => [
      record.accountId + ':' + record.idempotencyKey,
      copyOffer(record.offer),
    ]));
  }

  async get(accountId, idempotencyKey) {
    const offer = this.records.get(accountId + ':' + idempotencyKey);
    return offer ? copyOffer(offer) : undefined;
  }

  async getOrCreate({ accountId, idempotencyKey, offer }) {
    const key = accountId + ':' + idempotencyKey;
    const existing = this.records.get(key);
    if (existing) {
      if (!marketFactsMatch(offer, existing)) throw new Error('IDEMPOTENCY_CONFLICT');
      return copyOffer(existing);
    }
    const stored = copyOffer(offer);
    this.records.set(key, stored);
    return copyOffer(stored);
  }
}
