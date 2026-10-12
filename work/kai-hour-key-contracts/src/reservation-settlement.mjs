import { canonicalizeKaiSourceUrl } from './source-policy.mjs';

/** Stable Receipt built only from persisted execution facts, never recovery request fields. */
export function buildReservationReceipt(entry) {
  const b = entry.binding;
  return {
    receiptId: `rcpt_${entry.accountId}_${entry.idempotencyKey}`, accountId: entry.accountId,
    keyId: b.keyId, grantId: b.grantId, holdingId: b.holdingId, offerId: b.offerId,
    idempotencyKey: entry.idempotencyKey, hourKeyStatus: 'packaged',
    resource: { model: b.model, provider: b.provider, region: b.region }, slot: entry.holding.slot,
    requestHash: entry.requestHash, usage: entry.providerResult.usage, status: 'succeeded',
    createdAt: entry.reservedAt, sourceUrl: canonicalizeKaiSourceUrl(`https://kai.com/offers/${b.offerId}`),
  };
}

/** Shared settlement tail. No reserve operation or Provider dependency is accepted. */
export async function settleReservation({ store, entry: initial, receiptWriter, buildReceipt, beforeStep = async () => {} }) {
  let entry = initial;
  const move = async (to, payload = {}) => {
    await beforeStep();
    try {
      entry = await store.move({ accountId: entry.accountId, idempotencyKey: entry.idempotencyKey,
        ownerToken: entry.ownerToken, from: entry.state, to, ...payload });
    } catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
  };
  if (entry.state === 'provider_succeeded') await move('committed');
  if (entry.state === 'committed') {
    let receipt;
    try { receipt = buildReceipt ? buildReceipt({ providerResult: structuredClone(entry.providerResult), holding: structuredClone(entry.holding), reservedAt: entry.reservedAt }) : buildReservationReceipt(entry); }
    catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
    await move('receipt_prepared', { receipt });
  }
  if (entry.state === 'receipt_prepared') {
    await beforeStep();
    let receipt;
    try { receipt = await receiptWriter.append(structuredClone(entry.receipt)); }
    catch { throw new Error('RECEIPT_WRITE_FAILED'); }
    await move('receipt_committed', { receipt: structuredClone(receipt) });
  }
  if (entry.state !== 'receipt_committed') throw new Error('EXECUTION_LEDGER_FAILED');
  await beforeStep();
  return structuredClone({ receipt: entry.receipt, output: entry.providerResult.output });
}
