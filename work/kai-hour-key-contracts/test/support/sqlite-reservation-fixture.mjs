export const at = '2026-10-09T07:10:00.000Z';
export const holding = {
  accountId: 'account', holdingId: 'holding', grantId: 'grant', offerId: 'offer',
  resourceScope: { models: ['model'], providers: ['provider'], regions: ['region'] },
  slot: { slotStart: '2026-10-09T07:00:00.000Z', slotEnd: '2026-10-09T08:00:00.000Z', lockDeadline: '2026-10-09T06:55:00.000Z', timeZone: 'Asia/Shanghai' },
  unitsRemaining: 2, status: 'active',
};
export const success = { status: 'succeeded', providerRequestId: 'synthetic-provider-request', output: 'private-result', usage: { inputUnits: 1, outputUnits: 2, totalUnits: 3 } };
export const reservation = (id = 'operation-one') => ({
  accountId: holding.accountId, idempotencyKey: id, requestHash: `hash-${id}`, units: 1, at, ownerToken: `owner-${id}`,
  binding: { keyId: 'key', grantId: holding.grantId, holdingId: holding.holdingId, offerId: holding.offerId, model: 'model', provider: 'provider', region: 'region' },
});
export function execution(store, execute, id = 'operation-one') {
  const claim = reservation(id);
  return {
    ...claim, ...claim.binding, providerInput: 'synthetic-input', requestId: 'transport-id',
    providerAdapter: { execute }, receiptWriter: store.receiptWriter,
    buildReceipt: ({ providerResult }) => ({
      receiptId: `receipt-${id}`, accountId: claim.accountId, idempotencyKey: id, requestHash: claim.requestHash,
      keyId: 'key', grantId: holding.grantId, holdingId: holding.holdingId, offerId: holding.offerId,
      hourKeyStatus: 'packaged', resource: { model: 'model', provider: 'provider', region: 'region' },
      slot: holding.slot, usage: providerResult.usage, status: 'succeeded', createdAt: at, sourceUrl: 'https://kai.com/offers/offer',
    }),
  };
}
