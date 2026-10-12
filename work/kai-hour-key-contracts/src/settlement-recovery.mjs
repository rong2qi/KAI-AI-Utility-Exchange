import { resourceWithinScope } from './scope.mjs';
import { settleReservation } from './reservation-settlement.mjs';

const safeErrors = new Set(['REQUEST_INVALID', 'KEY_INVALID', 'AUTHORIZATION_EXPIRED', 'CAPABILITY_DENIED',
  'EXECUTION_NOT_FOUND', 'EXECUTION_LEDGER_FAILED', 'RECEIPT_WRITE_FAILED']);
const fail = (code) => { throw new Error(code); };
const within = (issuedAt, until, now) => Number.isFinite(now) && Date.parse(issuedAt) <= now && now < Date.parse(until);

/** Explicit settle-only command; accepts no Provider, prompt, new claim or client outcome. */
export class SettlementRecovery {
  constructor({ store, receiptWriter, keyVerifier, clock } = {}) {
    if (typeof store?.getReservation !== 'function' || typeof store?.move !== 'function'
      || typeof receiptWriter?.append !== 'function' || typeof keyVerifier?.verify !== 'function'
      || typeof clock?.now !== 'function') throw new Error('RECOVERY_CONFIG_INVALID');
    this.store = store; this.receiptWriter = receiptWriter; this.keyVerifier = keyVerifier; this.clock = clock;
  }

  async #authorize(opaqueKey, entry, expectedAccount) {
    let verified;
    try { verified = await this.keyVerifier.verify(opaqueKey, this.clock.now()); } catch { fail('KEY_INVALID'); }
    const now = Date.parse(this.clock.now());
    const { key, grants } = verified ?? {};
    if (!key || typeof key.accountId !== 'string' || !key.accountId || !Array.isArray(key.grantIds)
      || !Array.isArray(grants) || (expectedAccount && key.accountId !== expectedAccount)) fail('KEY_INVALID');
    if (!within(key.issuedAt, key.receiptUntil ?? key.expiresAt, now)) fail('AUTHORIZATION_EXPIRED');
    const allowed = grants.some((g) => g.accountId === key.accountId && key.grantIds.includes(g.grantId)
      && g.capabilityScope?.includes('usage.recover') && within(g.issuedAt, g.receiptUntil ?? g.expiresAt, now)
      && (g.revokedAt === undefined || now < Date.parse(g.revokedAt))
      && (!entry || (entry.accountId === key.accountId && entry.binding.keyId === key.keyId
        && entry.binding.grantId === g.grantId && resourceWithinScope(g.resourceScope, entry.binding))));
    if (!allowed) fail('CAPABILITY_DENIED');
    return key.accountId;
  }

  async recover(request) {
    try {
      if (!request || Object.keys(request).some((key) => !['opaqueKey', 'idempotencyKey'].includes(key))
        || typeof request.opaqueKey !== 'string' || !request.opaqueKey || request.opaqueKey.length > 4096
        || typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(request.idempotencyKey)) fail('REQUEST_INVALID');
      const accountId = await this.#authorize(request.opaqueKey);
      const entry = await this.store.getReservation(accountId, request.idempotencyKey);
      await this.#authorize(request.opaqueKey, entry, accountId);
      if (!entry) fail('EXECUTION_NOT_FOUND');
      if (['reserved', 'dispatching', 'uncertain'].includes(entry.state)) return {
        status: 'pending_reconciliation', reason: entry.state === 'reserved' ? 'ADMISSION_NOT_RESOLVED' : 'PROVIDER_OUTCOME_NOT_RECORDED',
      };
      if (entry.state === 'released') return { status: 'released' };
      const result = await settleReservation({ store: this.store, entry, receiptWriter: this.receiptWriter,
        beforeStep: () => this.#authorize(request.opaqueKey, entry, accountId) });
      return { status: 'settled', ...result };
    } catch (error) {
      const code = safeErrors.has(error?.message) ? error.message : 'EXECUTION_LEDGER_FAILED';
      return { status: 'error', code };
    }
  }
}
