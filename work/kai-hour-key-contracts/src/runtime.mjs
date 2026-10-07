import { canonicalizeKaiSourceUrl } from './source-policy.mjs';
import { classifyIntent, evaluateIntent } from './policy.mjs';
import { resourceWithinScope } from './scope.mjs';
import { asTime, slotState, validateSlotWindow } from './time.mjs';
import { marketFactsMatch } from './offer-facts.mjs';

const denyConfirmation = (decision) => ({
  ...decision,
  allowed: false,
  code: 'ASK_CONFIRMATION',
  reason: 'Explicit confirmation is required before a Holding lock is written',
});

const errorResponse = (requestId, code, message, retryable = false) => ({
  kind: 'error',
  error: { code, message, requestId, retryable },
});

const isValidIdempotencyKey = (value) => typeof value === 'string' && value.length >= 8;

const offerResource = (offer) => ({
  model: offer.resource.model,
  provider: offer.resource.provider,
  region: offer.resource.region,
});

/**
 * The only application seam. It owns orchestration but delegates storage,
 * catalog, clock, and provider behavior to injected ports.
 */
export class HourKeyRuntime {
  constructor({ clock, keyVerifier, offerCatalog, hourKeyPackager, holdingPort, providerAdapters, receiptWriter, requestHasher, usageLedger }) {
    if (!requestHasher) throw new Error('REQUEST_HASHER_REQUIRED');
    if (!hourKeyPackager) throw new Error('HOUR_KEY_PACKAGER_REQUIRED');
    if (!usageLedger) throw new Error('USAGE_LEDGER_REQUIRED');
    this.clock = clock;
    this.keyVerifier = keyVerifier;
    this.offerCatalog = offerCatalog;
    this.hourKeyPackager = hourKeyPackager;
    this.holdingPort = holdingPort;
    this.providerAdapters = providerAdapters;
    this.receiptWriter = receiptWriter;
    this.requestHasher = requestHasher;
    this.usageLedger = usageLedger;
    this.computeLocks = new Map();
  }

  async handle(request) {
    if (classifyIntent(request.userText).kind !== 'compute') return this.#handle(request);
    let verified;
    try {
      verified = await this.keyVerifier.verify(request.opaqueKey, this.clock.now());
    } catch {
      return errorResponse(request.requestId, 'KEY_INVALID', 'KAI Key could not be verified');
    }
    // One Runtime serializes settlement for one Holding. A database adapter must
    // provide cross-process reservation/fencing before this can scale to workers.
    const lockKey = JSON.stringify([verified.key.accountId, request.holdingId]);
    const previous = this.computeLocks.get(lockKey) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.computeLocks.set(lockKey, gate);
    await previous;
    try {
      // Re-read authorization, clock and Holding after waiting, never use a
      // queued request's former permission or unit balance.
      return await this.#handle(request);
    } finally {
      release();
      if (this.computeLocks.get(lockKey) === gate) this.computeLocks.delete(lockKey);
    }
  }

  async #checkProviderAdmission(request, expected) {
    let verified;
    try {
      verified = await this.keyVerifier.verify(request.opaqueKey, this.clock.now());
    } catch {
      return errorResponse(request.requestId, 'KEY_INVALID', 'KAI Key could not be verified');
    }
    if (verified.key.accountId !== expected.accountId || verified.key.keyId !== expected.keyId) {
      return errorResponse(request.requestId, 'KEY_INVALID', 'KAI Key binding changed before execution');
    }
    let holding;
    try {
      holding = await this.holdingPort.get(expected.accountId, expected.holdingId);
    } catch {
      return errorResponse(request.requestId, 'HOLDING_REQUIRED', 'Holding could not be read');
    }
    if (!holding) return errorResponse(request.requestId, 'HOLDING_REQUIRED', 'An active Holding is required for Compute');
    // Read the clock after asynchronous port I/O. This is the last admission
    // check before a Provider call, not a substitute for database reservations.
    const now = this.clock.now();
    try {
      if (slotState(holding.slot, now) !== 'active') {
        return errorResponse(request.requestId, 'SLOT_NOT_ACTIVE', 'Holding is outside its active execution window');
      }
    } catch {
      return errorResponse(request.requestId, 'SLOT_NOT_ACTIVE', 'Holding time window could not be verified');
    }
    const decision = evaluateIntent({ now, key: verified.key, grants: verified.grants, holding,
      intent: { kind: 'compute' }, requestedResource: expected.resource });
    if (!decision.allowed) return { kind: 'policy', decision };
    if (holding.accountId !== expected.accountId || holding.holdingId !== expected.holdingId
      || holding.grantId !== expected.grantId || decision.grantId !== expected.grantId
      || holding.offerId !== expected.offerId || !resourceWithinScope(holding.resourceScope, expected.resource)) {
      return { kind: 'policy', decision: { allowed: false, code: 'DENY_SCOPE', intent: 'compute',
        reason: 'Holding authorization or resource binding changed before execution', requiresUserConfirmation: false } };
    }
    if (!['held', 'active'].includes(holding.status) || holding.unitsRemaining <= 0) {
      return errorResponse(request.requestId, 'HOLDING_EXHAUSTED', 'Holding has no executable units');
    }
    return { decision };
  }

  async #handle(request) {
    const now = this.clock.now();
    let verified;
    try {
      verified = await this.keyVerifier.verify(request.opaqueKey, now);
    } catch {
      return errorResponse(request.requestId, 'KEY_INVALID', 'KAI Key could not be verified');
    }

    const intent = classifyIntent(request.userText);
    let lockOffer;
    if (intent.kind === 'lock' && request.offerId) {
      try {
        lockOffer = await this.offerCatalog.get(request.offerId);
      } catch {
        return errorResponse(request.requestId, 'CATALOG_UNAVAILABLE', 'KAI Offer catalog is unavailable', true);
      }
      if (!lockOffer) return errorResponse(request.requestId, 'OFFER_NOT_FOUND', 'The requested Offer was not found');
      try {
        canonicalizeKaiSourceUrl(lockOffer.sourceUrl);
      } catch {
        return errorResponse(request.requestId, 'SOURCE_URL_UNTRUSTED', 'Offer source is not a canonical KAI fact URL');
      }
      try {
        if (asTime(lockOffer.validUntil) <= asTime(now)) {
          return errorResponse(request.requestId, 'OFFER_STALE', 'Offer validity has ended; refresh the current market Offer', true);
        }
      } catch {
        return errorResponse(request.requestId, 'OFFER_STALE', 'Offer validity could not be verified');
      }
      try {
        validateSlotWindow(lockOffer.slot);
      } catch {
        return errorResponse(request.requestId, 'OFFER_STALE', 'Offer time window could not be verified');
      }
      if (asTime(lockOffer.slot.lockDeadline) <= asTime(now)) {
        return errorResponse(request.requestId, 'LOCK_DEADLINE_CLOSED', 'Offer lock deadline has passed');
      }
    }
    let existingHolding;
    if ((intent.kind === 'compute' || intent.kind === 'lock') && request.holdingId) {
      try {
        existingHolding = await this.holdingPort.get(verified.key.accountId, request.holdingId);
      } catch {
        return errorResponse(request.requestId, 'HOLDING_REQUIRED', 'Holding could not be read');
      }
    }
    const decision = evaluateIntent({
      now,
      key: verified.key,
      grants: verified.grants,
      holding: existingHolding,
      intent,
      requestedResource: lockOffer ? offerResource(lockOffer) : request.requestedResource,
    });

    if (!decision.allowed) return { kind: 'policy', decision };
    if (intent.kind === 'lock' && request.confirmed !== true) {
      return { kind: 'policy', decision: denyConfirmation(decision) };
    }

    if (intent.kind === 'discovery') {
      let offers;
      try {
        offers = await this.offerCatalog.query({
          accountId: verified.key.accountId,
          requestedResource: request.requestedResource,
          at: now,
        });
      } catch {
        return errorResponse(request.requestId, 'CATALOG_UNAVAILABLE', 'KAI Offer catalog is unavailable', true);
      }
      try {
        offers.forEach((offer) => canonicalizeKaiSourceUrl(offer.sourceUrl));
      } catch {
        return errorResponse(request.requestId, 'SOURCE_URL_UNTRUSTED', 'Offer source is not a canonical KAI fact URL');
      }
      return { kind: 'offers', offers, decision };
    }

    if (intent.kind === 'lock') {
      if (!request.offerId || !isValidIdempotencyKey(request.idempotencyKey)) {
        return errorResponse(request.requestId, 'REQUEST_INVALID', 'offerId and idempotencyKey are required to lock an Offer');
      }
      if (lockOffer.executionEligible !== true) {
        return errorResponse(request.requestId, 'HOUR_KEY_PACKAGING_FAILED', 'Offer is not eligible for Hour Key packaging');
      }
      if (lockOffer.availability === 'unavailable') {
        return errorResponse(request.requestId, 'HOUR_KEY_PACKAGING_FAILED', 'Offer is currently unavailable', true);
      }
      let packagedOffer;
      try {
        packagedOffer = await this.hourKeyPackager.package({
          accountId: verified.key.accountId,
          offer: lockOffer,
          idempotencyKey: request.idempotencyKey,
        });
      } catch (error) {
        const nonRetryable = ['IDEMPOTENCY_CONFLICT', 'PACKAGING_COMMAND_INVALID', 'HOUR_KEY_STATUS_INVALID'].includes(error?.message);
        return errorResponse(request.requestId, 'HOUR_KEY_PACKAGING_FAILED', 'KAI Hour Key packaging could not be completed', !nonRetryable);
      }
      if (
        packagedOffer?.hourKeyStatus !== 'packaged'
        || packagedOffer.executionEligible !== true
        || packagedOffer.availability === 'unavailable'
        || !marketFactsMatch(lockOffer, packagedOffer)
      ) {
        return errorResponse(request.requestId, 'HOUR_KEY_PACKAGING_FAILED', 'KAI Hour Key packaging changed or omitted market facts');
      }
      let holding;
      try {
        holding = await this.holdingPort.lock({
          accountId: verified.key.accountId,
          grantId: decision.grantId,
          offerId: packagedOffer.offerId,
          at: now,
          idempotencyKey: request.idempotencyKey,
        });
      } catch {
        return errorResponse(request.requestId, 'HOLDING_LOCK_FAILED', 'Holding lock could not be completed');
      }
      if (
        !holding
        || holding.accountId !== verified.key.accountId
        || holding.grantId !== decision.grantId
        || holding.offerId !== packagedOffer.offerId
      ) {
        return errorResponse(request.requestId, 'HOLDING_LOCK_FAILED', 'Holding lock returned an unbound Holding');
      }
      return { kind: 'holding', holding, decision };
    }

    if (intent.kind === 'receipt') {
      if (!request.receiptId) return errorResponse(request.requestId, 'REQUEST_INVALID', 'receiptId is required to read a Receipt');
      let receipt;
      try {
        receipt = await this.receiptWriter.get(verified.key.accountId, request.receiptId);
      } catch {
        return errorResponse(request.requestId, 'RECEIPT_NOT_FOUND', 'Receipt was not found');
      }
      if (!receipt) return errorResponse(request.requestId, 'RECEIPT_NOT_FOUND', 'Receipt was not found');
      return { kind: 'receipt', receipt, decision };
    }

    if (!request.holdingId || !existingHolding) return errorResponse(request.requestId, 'HOLDING_REQUIRED', 'An active Holding is required for Compute');
    if (existingHolding.accountId !== verified.key.accountId || existingHolding.grantId !== decision.grantId) {
      return { kind: 'policy', decision: {
        allowed: false,
        code: 'DENY_SCOPE',
        intent: intent.kind,
        reason: 'Holding is not bound to the selected authorization grant',
        requiresUserConfirmation: false,
      } };
    }
    try {
      if (slotState(existingHolding.slot, now) !== 'active') {
        return errorResponse(request.requestId, 'SLOT_NOT_ACTIVE', 'Holding is outside its active execution window');
      }
    } catch {
      return errorResponse(request.requestId, 'SLOT_NOT_ACTIVE', 'Holding time window could not be verified');
    }
    if (!['held', 'active', 'exhausted'].includes(existingHolding.status)) {
      return errorResponse(request.requestId, 'HOLDING_EXHAUSTED', 'Holding has no executable units');
    }
    if (request.providerInput === undefined) return errorResponse(request.requestId, 'REQUEST_INVALID', 'providerInput is required for Compute');
    if (!isValidIdempotencyKey(request.idempotencyKey)) return errorResponse(request.requestId, 'REQUEST_INVALID', 'idempotencyKey must be at least 8 characters for Compute');

    const model = request.requestedResource?.model ?? existingHolding.resourceScope.models[0];
    const provider = request.requestedResource?.provider ?? existingHolding.resourceScope.providers[0];
    const region = request.requestedResource?.region ?? existingHolding.resourceScope.regions[0];
    if (!resourceWithinScope(existingHolding.resourceScope, { model, provider, region })) {
      return { kind: 'policy', decision: {
        allowed: false,
        code: 'DENY_SCOPE',
        intent: intent.kind,
        reason: 'Requested resource is outside the existing Holding scope',
        requiresUserConfirmation: false,
      } };
    }
    const adapter = this.providerAdapters.get(provider);
    if (!adapter) return errorResponse(request.requestId, 'PROVIDER_UNAVAILABLE', `No Provider Adapter is registered for ${provider}`, true);
    const requestHash = this.requestHasher.hash({ model, provider, region, input: request.providerInput });

    let execution;
    let executionDecision = decision;
    let preflightRejection;
    try {
      execution = await this.usageLedger.executeWithResult({
        accountId: verified.key.accountId,
        keyId: verified.key.keyId,
        grantId: decision.grantId,
        holdingId: existingHolding.holdingId,
        offerId: existingHolding.offerId,
        model,
        provider,
        region,
        providerInput: request.providerInput,
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        at: now,
        providerAdapter: adapter,
        holdingPort: this.holdingPort,
        receiptWriter: this.receiptWriter,
        beforeProviderExecution: async () => {
          const admission = await this.#checkProviderAdmission(request, {
            accountId: verified.key.accountId, keyId: verified.key.keyId, grantId: decision.grantId,
            holdingId: existingHolding.holdingId, offerId: existingHolding.offerId,
            resource: { model, provider, region },
          });
          if (admission.kind) {
            preflightRejection = admission;
            throw new Error('EXECUTION_PRECHECK_DENIED');
          }
          executionDecision = admission.decision;
        },
        buildReceipt: ({ providerResult, holding }) => ({
          receiptId: `rcpt_${verified.key.accountId}_${request.idempotencyKey}`,
          accountId: verified.key.accountId,
          keyId: verified.key.keyId,
          grantId: decision.grantId,
          holdingId: holding.holdingId,
          offerId: holding.offerId,
          idempotencyKey: request.idempotencyKey,
          hourKeyStatus: 'packaged',
          resource: { model, provider, region },
          slot: holding.slot,
          requestHash,
          usage: providerResult.usage,
          status: 'succeeded',
          createdAt: now,
          sourceUrl: canonicalizeKaiSourceUrl(`https://kai.com/offers/${holding.offerId}`),
        }),
      });
    } catch (error) {
      if (preflightRejection) return preflightRejection;
      const code = error?.message;
      const publicCode = ['IDEMPOTENCY_CONFLICT', 'PROVIDER_UNAVAILABLE', 'HOLDING_EXHAUSTED', 'HOLDING_REQUIRED', 'RECEIPT_WRITE_FAILED'].includes(code)
        ? code : 'EXECUTION_LEDGER_FAILED';
      const retryable = !['IDEMPOTENCY_CONFLICT', 'HOLDING_EXHAUSTED', 'HOLDING_REQUIRED', 'EXECUTION_COMMAND_INVALID'].includes(code);
      const message = publicCode === 'IDEMPOTENCY_CONFLICT'
        ? 'The idempotency key was already used with different request facts'
        : publicCode === 'RECEIPT_WRITE_FAILED'
          ? 'Usage completed but Receipt could not be written'
          : publicCode === 'HOLDING_EXHAUSTED'
            ? 'Holding has no executable units'
            : publicCode === 'HOLDING_REQUIRED'
              ? 'Holding could not be consumed'
              : publicCode === 'PROVIDER_UNAVAILABLE'
                ? 'Provider did not complete the request'
                : 'Usage execution ledger could not resume safely';
      return errorResponse(request.requestId, publicCode, message, retryable);
    }
    return { kind: 'receipt', receipt: execution.receipt, output: execution.output, decision: executionDecision };
  }
}
