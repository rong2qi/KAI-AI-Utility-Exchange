import { canonicalizeKaiSourceUrl } from '../source-policy.mjs';

const REFERENCE_PROVIDER = 'reference-market';
const PUBLIC_MARKET_BASE = 'https://pricing.kai.com/v1';
const PUBLIC_MARKET_TTL_MS = 5 * 60 * 1000;

function normalizeAvailability(status) {
  if (status === 'available' || status === 'limited' || status === 'unavailable') return status;
  throw new Error('REFERENCE_MARKET_AVAILABILITY_INVALID');
}

const slug = (value) => String(value).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120);

/**
 * Read-only adapter for the existing public reference market.
 * It deliberately cannot create a Holding or execute a Provider request.
 */
export class ReferenceMarketCatalogAdapter {
  constructor({ fetchJson, slotFactory, baseUrl = PUBLIC_MARKET_BASE }) {
    if (typeof fetchJson !== 'function') throw new Error('REFERENCE_MARKET_FETCH_REQUIRED');
    if (typeof slotFactory !== 'function') throw new Error('REFERENCE_MARKET_SLOT_FACTORY_REQUIRED');
    this.fetchJson = fetchJson;
    this.slotFactory = slotFactory;
    this.baseUrl = baseUrl;
    this.mode = 'market_data';
  }

  async query({ requestedResource = {} }) {
    const raw = await this.fetchJson(`${this.baseUrl}/prices`);
    const items = raw?.data?.items ?? raw?.items;
    if (!Array.isArray(items)) throw new Error('REFERENCE_MARKET_PAYLOAD_INVALID');
    return items
      .map((item) => this.toOffer(item))
      .filter((offer) => (
        (requestedResource.model == null || offer.resource.model === requestedResource.model)
        && (requestedResource.provider == null || offer.resource.provider === requestedResource.provider)
        && (requestedResource.region == null || offer.resource.region === requestedResource.region)
      ));
  }

  async get(offerId) {
    const offers = await this.query({});
    return offers.find((offer) => offer.offerId === offerId);
  }

  toOffer(item) {
    const productId = item.productId ?? item.gpuModel;
    const retrievedAt = item.asOf;
    const validUntil = new Date(Date.parse(retrievedAt) + PUBLIC_MARKET_TTL_MS).toISOString();
    const offerId = `ref_${slug(productId)}`;
    return {
      offerId,
      resource: {
        model: item.gpuModel ?? item.gpuName ?? productId,
        provider: REFERENCE_PROVIDER,
        region: item.region,
      },
      slot: this.slotFactory(item),
      price: {
        amount: String(item.selectedPrice ?? item.canonicalPrice?.amount ?? ''),
        currency: item.selectedCurrency ?? item.canonicalPrice?.currency ?? 'CNY',
        unit: item.unit ?? 'GPU_HOUR',
      },
      availability: normalizeAvailability(item.availability?.status),
      retrievedAt,
      validUntil,
      sourceUrl: canonicalizeKaiSourceUrl(`https://kai.com/offers/${offerId}`),
      executionEligible: true,
      hourKeyStatus: 'unpackaged',
    };
  }
}

export const referenceMarketProviderId = REFERENCE_PROVIDER;
