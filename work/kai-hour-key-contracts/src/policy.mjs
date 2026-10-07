import { classifyIntent } from './intent.mjs';
import { candidateGrants, capabilityForIntent, linkedGrants, resourceWithinScope } from './scope.mjs';
import { asTime, slotState, validateSlotWindow } from './time.mjs';

const deny = (code, intent, reason, extra = {}) => ({
  allowed: false, code, intent: intent.kind, reason, requiresUserConfirmation: false, ...extra,
});

export { asTime, classifyIntent, slotState, validateSlotWindow };

export function evaluateIntent({ now, key, grants, holding, intent, requestedResource = {} }) {
  const current = asTime(now);
  if (!key) return deny('DENY_KEY', intent, 'No account-bound KAI key was supplied');

  const keyExpired = current >= asTime(key.expiresAt);
  const receiptStillReadable = intent.kind === 'receipt' && current < asTime(key.receiptUntil ?? key.expiresAt);
  if (keyExpired && !receiptStillReadable) return deny('DENY_EXPIRED', intent, 'Account-bound KAI key is expired');

  if (intent.kind === 'ambiguous') {
    return { allowed: false, code: 'ASK_CLARIFICATION', intent: intent.kind,
      reason: 'Ask whether to query KAI real-time Offer data', requiresUserConfirmation: true };
  }

  const grantCandidates = candidateGrants({ key, grants, now, intent, requestedResource });
  const grant = intent.kind === 'compute' && holding?.grantId
    ? grantCandidates.find((candidate) => candidate.grantId === holding.grantId)
    : grantCandidates[0];
  if (!grant && intent.kind === 'compute' && holding?.grantId && grantCandidates.length > 0) {
    return deny('DENY_SCOPE', intent, 'Holding is bound to a different authorization grant');
  }
  if (!grant) {
    const linked = linkedGrants({ key, grants });
    if (linked.length === 0) return deny('DENY_KEY', intent, 'No authorization grant is linked to this account key');
    const matching = linked.filter((item) => (
      item.capabilityScope.includes(capabilityForIntent(intent.kind))
      && resourceWithinScope(item.resourceScope, requestedResource)
    ));
    const unrevoked = matching.filter((item) => !item.revokedAt || current < asTime(item.revokedAt));
    if (matching.length > 0 && unrevoked.length === 0) {
      return deny('DENY_REVOKED', intent, 'All matching authorization grants are revoked');
    }
    if (unrevoked.length > 0 && unrevoked.every((item) => current >= asTime(
      intent.kind === 'receipt' ? item.receiptUntil ?? item.expiresAt : item.expiresAt,
    ))) {
      return deny('DENY_EXPIRED', intent, 'Matching authorization grants have expired');
    }
    if (Object.keys(requestedResource).length > 0) {
      return deny('SCOPE_EXPANSION_REQUIRED', intent,
        'Requested model, provider, or region requires a new authorization scope');
    }
    return deny('DENY_CAPABILITY', intent, `No active grant exposes ${capabilityForIntent(intent.kind)}`);
  }

  const state = slotState(grant.slot, now);
  if (intent.kind === 'compute' && state !== 'active') {
    return deny(state === 'expired' ? 'DENY_EXPIRED' : 'DENY_SLOT_NOT_ACTIVE', intent,
      'Compute is allowed only when slot_start <= server_now < slot_end', { grantId: grant.grantId });
  }
  if (intent.kind === 'lock' && state !== 'before_lock') {
    return { ...deny(state === 'expired' ? 'DENY_EXPIRED' : 'DENY_LOCK_DEADLINE', intent,
      'New Holding locks close at the Offer lock_deadline', { grantId: grant.grantId }), requiresUserConfirmation: true };
  }
  if (intent.kind === 'lock' && holding?.status === 'revoked') {
    return deny('DENY_REVOKED', intent, 'Holding is revoked', { grantId: grant.grantId });
  }

  const selectedPort = intent.kind === 'compute' ? 'compute'
    : intent.kind === 'discovery' ? 'offer_catalog'
      : intent.kind === 'lock' ? 'holding' : 'receipt';
  const code = intent.kind === 'compute' ? 'ALLOW_COMPUTE'
    : intent.kind === 'discovery' ? 'ALLOW_DISCOVERY'
      : intent.kind === 'lock' ? 'ALLOW_LOCK' : 'ALLOW_RECEIPT';
  return { allowed: true, code, intent: intent.kind, grantId: grant.grantId,
    reason: `Authorized by grant ${grant.grantId} at scope epoch ${grant.scopeEpoch ?? grant.version}`,
    requiresUserConfirmation: intent.kind === 'lock', selectedPort };
}

export function canExecuteAlternative({ grant, requestedResource }) {
  return grant.allowProviderSwitch === true
    && resourceWithinScope(grant.resourceScope, requestedResource);
}
