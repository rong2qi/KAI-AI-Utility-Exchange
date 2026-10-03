export class MemoryClock {
  constructor(now) { this.value = now; }
  now() { return this.value; }
  set(now) { this.value = now; }
}

export class MemoryKeyVerifier {
  constructor(entries = []) { this.entries = new Map(entries); }
  async verify(opaqueKey) {
    const entry = this.entries.get(opaqueKey);
    if (!entry) throw new Error('KEY_INVALID');
    return entry;
  }
}

export class MemoryOfferCatalog {
  constructor(offers = []) {
    this.mode = 'transactional';
    this.offers = offers;
    this.queryCalls = 0;
    this.getCalls = 0;
  }

  async query({ requestedResource = {} }) {
    this.queryCalls += 1;
    return this.offers.filter((offer) => (
      (requestedResource.model == null || offer.resource.model === requestedResource.model)
      && (requestedResource.provider == null || offer.resource.provider === requestedResource.provider)
      && (requestedResource.region == null || offer.resource.region === requestedResource.region)
    ));
  }

  async get(offerId) {
    this.getCalls += 1;
    return this.offers.find((offer) => offer.offerId === offerId);
  }
}

export class MemoryHourKeyPackagingPort {
  constructor() {
    this.calls = 0;
    this.error = undefined;
  }

  async package({ offer }) {
    this.calls += 1;
    if (this.error) throw this.error;
    return { ...offer, hourKeyStatus: 'packaged' };
  }
}

export class MemoryHoldingPort {
  constructor({ holdings = [], lockTemplates = [] } = {}) {
    this.holdings = new Map(holdings.map((holding) => [holding.holdingId, { ...holding }]));
    this.lockTemplates = new Map(lockTemplates.map((holding) => [holding.offerId, { ...holding }]));
    this.consumeCalls = 0;
    this.lockCalls = 0;
    this.consumptions = new Map();
  }

  async getCurrent(accountId) {
    return [...this.holdings.values()].find((holding) => holding.accountId === accountId && ['held', 'active'].includes(holding.status));
  }

  async get(accountId, holdingId) {
    const holding = this.holdings.get(holdingId);
    return holding?.accountId === accountId ? { ...holding } : undefined;
  }

  async lock({ accountId, grantId, offerId, idempotencyKey }) {
    this.lockCalls += 1;
    const template = this.lockTemplates.get(offerId);
    if (!template) throw new Error('OFFER_NOT_LOCKABLE');
    const existing = [...this.holdings.values()].find((holding) => holding.accountId === accountId && holding.idempotencyKey === idempotencyKey);
    if (existing) return { ...existing };
    const holding = { ...template, accountId, grantId, idempotencyKey, status: 'held' };
    this.holdings.set(holding.holdingId, holding);
    return { ...holding };
  }

  async consume({ accountId, holdingId, units, idempotencyKey }) {
    const consumptionKey = accountId + ':' + idempotencyKey;
    const repeated = this.consumptions.get(consumptionKey);
    if (repeated) return { ...repeated };
    this.consumeCalls += 1;
    const holding = this.holdings.get(holdingId);
    if (!holding || holding.accountId !== accountId) throw new Error('HOLDING_REQUIRED');
    if (holding.unitsRemaining < units) throw new Error('HOLDING_EXHAUSTED');
    const updated = { ...holding, unitsRemaining: holding.unitsRemaining - units };
    if (updated.unitsRemaining === 0) updated.status = 'exhausted';
    else if (updated.status === 'held') updated.status = 'active';
    this.holdings.set(holdingId, updated);
    this.consumptions.set(consumptionKey, updated);
    return { ...updated };
  }
}

export class MemoryProviderAdapter {
  constructor(providerId) { this.providerId = providerId; this.calls = 0; this.requests = []; this.results = new Map(); }
  async execute({ model, region, input, requestId, idempotencyKey }) {
    this.calls += 1;
    this.requests.push({ model, region, input, requestId, idempotencyKey });
    const existing = this.results.get(idempotencyKey);
    if (existing) return { ...existing };
    const result = {
      providerRequestId: `provider_${idempotencyKey}`,
      output: { model, region, echo: input },
      usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 },
      status: 'succeeded',
    };
    this.results.set(idempotencyKey, result);
    return result;
  }
}

export class MemoryReceiptWriter {
  constructor(receipts = []) { this.receipts = new Map(receipts.map((receipt) => [receipt.receiptId, receipt])); this.appendCalls = 0; }
  async append(receipt) {
    const existing = [...this.receipts.values()].find((item) => item.accountId === receipt.accountId && item.idempotencyKey === receipt.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== receipt.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return { ...existing };
    }
    this.appendCalls += 1;
    this.receipts.set(receipt.receiptId, receipt);
    return receipt;
  }
  async getByIdempotencyKey(accountId, idempotencyKey) {
    return [...this.receipts.values()].find((receipt) => receipt.accountId === accountId && receipt.idempotencyKey === idempotencyKey);
  }
  async get(accountId, receiptId) {
    const receipt = this.receipts.get(receiptId);
    return receipt?.accountId === accountId ? receipt : undefined;
  }
}

export class MemoryRequestHasher {
  hash(value) { return `sha256:test:${JSON.stringify(value)}`; }
}
