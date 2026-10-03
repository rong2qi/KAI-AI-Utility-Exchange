import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReferenceMarketCatalogAdapter, referenceMarketProviderId } from '../src/adapters/reference-market.mjs';

const slot = {
  slotStart: '2026-10-02T18:00:00.000Z',
  lockDeadline: '2026-10-02T17:55:00.000Z',
  slotEnd: '2026-10-02T19:00:00.000Z',
  timeZone: 'Asia/Shanghai',
};

test('real market Offers remain execution eligible before KAI Hour Key packaging', async () => {
  const calls = [];
  const adapter = new ReferenceMarketCatalogAdapter({
    fetchJson: async (url) => {
      calls.push(url);
      return { data: { items: [{ productId: 'gpu/a', gpuModel: 'model-a', region: 'region-a', selectedPrice: '1.20', selectedCurrency: 'CNY', unit: 'GPU_HOUR', asOf: '2026-10-02T17:50:00.000Z', availability: { status: 'available' } }] } };
    },
    slotFactory: () => slot,
  });
  const offers = await adapter.query({});
  assert.equal(adapter.mode, 'market_data');
  assert.deepEqual(calls, ['https://pricing.kai.com/v1/prices']);
  assert.equal(offers[0].resource.provider, referenceMarketProviderId);
  assert.equal(offers[0].executionEligible, true);
  assert.equal(offers[0].hourKeyStatus, 'unpackaged');
  assert.equal(offers[0].sourceUrl, 'https://kai.com/offers/ref_gpu_a');
  assert.equal(offers[0].validUntil, '2026-10-02T17:55:00.000Z');
});

test('reference market adapter filters by normalized catalog dimensions', async () => {
  const adapter = new ReferenceMarketCatalogAdapter({
    fetchJson: async () => ({ items: [
      { productId: 'a', gpuModel: 'model-a', region: 'region-a', selectedPrice: '1', asOf: '2026-10-02T17:50:00.000Z', availability: { status: 'available' } },
      { productId: 'b', gpuModel: 'model-b', region: 'region-b', selectedPrice: '2', asOf: '2026-10-02T17:50:00.000Z', availability: { status: 'available' } },
    ] }),
    slotFactory: () => slot,
  });
  const offers = await adapter.query({ requestedResource: { model: 'model-b' } });
  assert.deepEqual(offers.map((offer) => offer.resource.model), ['model-b']);
});

test('reference market preserves an unavailable source status instead of downgrading it to limited', async () => {
  const adapter = new ReferenceMarketCatalogAdapter({
    fetchJson: async () => ({ items: [
      { productId: 'unavailable', gpuModel: 'model-a', region: 'region-a', selectedPrice: '1', asOf: '2026-10-02T17:50:00.000Z', availability: { status: 'unavailable' } },
    ] }),
    slotFactory: () => slot,
  });

  const [offer] = await adapter.query({});

  assert.equal(offer.availability, 'unavailable');
});
