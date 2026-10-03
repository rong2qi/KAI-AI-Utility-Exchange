import { asTime } from './time.mjs';

export const resourceWithinScope = (scope, requested = {}) => (
  (requested.model == null || scope.models.includes(requested.model))
  && (requested.provider == null || scope.providers.includes(requested.provider))
  && (requested.region == null || scope.regions.includes(requested.region))
);

export function capabilityForIntent(kind) {
  return kind === 'compute' ? 'compute'
    : kind === 'discovery' ? 'discovery.read'
      : kind === 'lock' ? 'discovery.lock' : 'usage.receipt';
}

export function grantUsableAt(grant, now, kind) {
  const current = asTime(now);
  if (grant.revokedAt && current >= asTime(grant.revokedAt)) return false;
  if (current < asTime(grant.issuedAt)) return false;
  const end = kind === 'receipt' ? asTime(grant.receiptUntil ?? grant.expiresAt) : asTime(grant.expiresAt);
  return current < end;
}

export function candidateGrants({ key, grants, now, intent, requestedResource = {} }) {
  const capability = capabilityForIntent(intent.kind);
  return grants.filter((grant) => grant.accountId === key.accountId
    && key.grantIds.includes(grant.grantId)
    && grantUsableAt(grant, now, intent.kind)
    && resourceWithinScope(grant.resourceScope, requestedResource)
    && grant.capabilityScope.includes(capability));
}

export function linkedGrants({ key, grants }) {
  return grants.filter((grant) => grant.accountId === key.accountId && key.grantIds.includes(grant.grantId));
}

export function activeAccountGrants({ key, grants, now, intent }) {
  return linkedGrants({ key, grants }).filter((grant) => grantUsableAt(grant, now, intent.kind));
}
