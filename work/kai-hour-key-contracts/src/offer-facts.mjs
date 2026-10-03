export const copyOffer = (offer) => ({
  ...offer,
  resource: { ...offer.resource },
  slot: { ...offer.slot },
  price: { ...offer.price },
});

/** Packaging may advance only hourKeyStatus; every market fact must remain equal. */
export const marketFactsMatch = (source, candidate) => (
  candidate?.offerId === source.offerId
  && JSON.stringify(candidate.resource) === JSON.stringify(source.resource)
  && JSON.stringify(candidate.slot) === JSON.stringify(source.slot)
  && JSON.stringify(candidate.price) === JSON.stringify(source.price)
  && candidate.availability === source.availability
  && candidate.retrievedAt === source.retrievedAt
  && candidate.validUntil === source.validUntil
  && candidate.sourceUrl === source.sourceUrl
  && candidate.executionEligible === source.executionEligible
);
