/** @typedef {import('../types/index.js').Holding} Holding */
/** @typedef {import('../types/index.js').UsageReceipt} UsageReceipt */
/** @typedef {import('../ports/index.js').ProviderExecutionResult} ProviderResult */
/** @typedef {import('../ports/index.js').UsageExecutionBinding} Binding */
/** @typedef {import('../ports/reservations.js').ReservationState} ReservationState */
/** @typedef {import('../ports/reservations.js').ReservationEntry} ReservationEntry */
/** @typedef {import('../ports/reservations.js').ReserveCommand} ReserveCommand */
/** @typedef {import('../ports/reservations.js').MoveReservationCommand} MoveCommand */
/** @typedef {import('../ports/reservations.js').ReservationSnapshot} ReservationSnapshot */

/** @template T @param {T} value @returns {T} */
const clone = (value) => structuredClone(value);
/** @param {string} accountId @param {string} id */
const keyOf = (accountId, id) => JSON.stringify([accountId, id]);
/** @param {unknown} value */
const text = (value) => typeof value === 'string' && value.length > 0;
/** @param {unknown} condition @param {string} [code] */
function requireThat(condition, code = 'RESERVATION_INVALID') {
  if (!condition) throw new Error(code);
}
/** @param {unknown} value */
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** @param {unknown} value */
const time = (value) => typeof value === 'string' ? Date.parse(value) : NaN;

/** @param {unknown} value @param {Set<object>} [ancestors] @returns {string} */
export function canonicalReservationValue(value, ancestors = new Set()) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('RESERVATION_INVALID');
  requireThat(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ancestors.add(value);
  const object = /** @type {Record<string, unknown>} */ (value);
  const result = Array.isArray(value) ? `[${Array.from(value, (item) => canonicalReservationValue(item, ancestors)).join(',')}]`
    : `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalReservationValue(object[key], ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return result;
}
/** @param {unknown} left @param {unknown} right */
const same = (left, right) => canonicalReservationValue(left) === canonicalReservationValue(right);

/** @type {Record<ReservationState, readonly ReservationState[]>} */
const transitions = {
  reserved: ['dispatching', 'released'], dispatching: ['provider_succeeded', 'uncertain', 'released'],
  provider_succeeded: ['committed'], committed: ['receipt_prepared'], receipt_prepared: ['receipt_committed'],
  uncertain: [], released: [], receipt_committed: [],
};
const committedStates = ['committed', 'receipt_prepared', 'receipt_committed'];
const receiptStates = ['receipt_prepared', 'receipt_committed'];

/** @param {Holding} holding */
function validateHolding(holding) {
  requireThat(holding && text(holding.accountId) && text(holding.holdingId) && text(holding.grantId) && text(holding.offerId));
  requireThat(integer(holding.unitsRemaining) && ['held', 'active', 'exhausted', 'expired', 'revoked'].includes(holding.status));
  requireThat(holding.resourceScope && Object.values(holding.resourceScope).length === 3);
  for (const values of [holding.resourceScope.models, holding.resourceScope.providers, holding.resourceScope.regions]) {
    requireThat(Array.isArray(values) && values.length > 0 && values.every(text));
  }
  requireThat(holding.slot && text(holding.slot.timeZone)
    && time(holding.slot.lockDeadline) <= time(holding.slot.slotStart)
    && time(holding.slot.slotStart) < time(holding.slot.slotEnd));
}

/** @param {Binding} binding @param {Holding} holding */
function bindingMatches(binding, holding) {
  return binding && text(binding.keyId) && binding.holdingId === holding.holdingId
    && binding.grantId === holding.grantId && binding.offerId === holding.offerId
    && holding.resourceScope.models.includes(binding.model)
    && holding.resourceScope.providers.includes(binding.provider)
    && holding.resourceScope.regions.includes(binding.region);
}

/** @param {ProviderResult | undefined} result */
function validateResult(result) {
  if (!result) throw new Error('RESERVATION_INVALID');
  requireThat(result.status === 'succeeded' && text(result.providerRequestId) && result.usage
    && Object.hasOwn(result, 'output') && result.output !== undefined);
  requireThat([result.usage.inputUnits, result.usage.outputUnits, result.usage.totalUnits]
    .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && result.usage.totalUnits === result.usage.inputUnits + result.usage.outputUnits);
  canonicalReservationValue(result);
}

/** @param {UsageReceipt | undefined} receipt @param {ReservationEntry} entry */
function validateReceipt(receipt, entry) {
  if (!receipt || !entry.holding || !entry.providerResult) throw new Error('RESERVATION_INVALID');
  requireThat(text(receipt.receiptId) && receipt.accountId === entry.accountId && receipt.idempotencyKey === entry.idempotencyKey
    && receipt.requestHash === entry.requestHash && receipt.holdingId === entry.binding.holdingId
    && receipt.keyId === entry.binding.keyId && receipt.grantId === entry.binding.grantId && receipt.offerId === entry.binding.offerId
    && receipt.hourKeyStatus === 'packaged' && receipt.status === 'succeeded'
    && Number.isFinite(time(receipt.createdAt)) && text(receipt.sourceUrl));
  requireThat(receipt.resource?.model === entry.binding.model && receipt.resource?.provider === entry.binding.provider
    && receipt.resource?.region === entry.binding.region && same(receipt.slot, entry.holding.slot)
    && same(receipt.usage, entry.providerResult.usage));
  canonicalReservationValue(receipt);
}

/** @param {ReservationEntry} entry @param {Holding | undefined} holding */
function validateEntry(entry, holding) {
  requireThat(entry && holding && text(entry.accountId) && text(entry.idempotencyKey)
    && text(entry.requestHash) && text(entry.ownerToken) && entry.units === 1
    && Object.hasOwn(transitions, entry.state) && Number.isFinite(time(entry.reservedAt)));
  if (!holding) throw new Error('RESERVATION_INVALID');
  requireThat(entry.accountId === holding.accountId && bindingMatches(entry.binding, holding)
    && time(holding.slot.slotStart) <= time(entry.reservedAt) && time(entry.reservedAt) < time(holding.slot.slotEnd));
  const succeeded = entry.state === 'provider_succeeded' || committedStates.includes(entry.state);
  const committed = committedStates.includes(entry.state);
  if (succeeded) validateResult(entry.providerResult);
  else requireThat(entry.providerResult === undefined);
  if (committed) {
    if (!entry.holding) throw new Error('RESERVATION_INVALID');
    validateHolding(entry.holding);
    requireThat(entry.holding.accountId === holding.accountId && bindingMatches(entry.binding, entry.holding)
      && same(entry.holding.resourceScope, holding.resourceScope) && same(entry.holding.slot, holding.slot)
      && entry.holding.status === (entry.holding.unitsRemaining === 0 ? 'exhausted' : 'active'));
  } else requireThat(entry.holding === undefined);
  if (receiptStates.includes(entry.state)) validateReceipt(entry.receipt, entry);
  else requireThat(entry.receipt === undefined);
  canonicalReservationValue(entry);
}

/** @param {ReservationEntry} entry */
const isReserved = (entry) => ['reserved', 'dispatching', 'provider_succeeded', 'uncertain'].includes(entry.state);

/**
 * Synchronous reservation rules shared by memory and transactional adapters.
 * No I/O or external side effects occur inside this state machine.
 */
export class ReservationStateMachine {
  /** @type {Map<string, Holding>} */
  #holdings = new Map();
  /** @type {Map<string, number>} */
  #totals = new Map();
  /** @type {Map<string, ReservationEntry>} */
  #entries = new Map();

  /** @param {{ holdings?: readonly Holding[], snapshot?: ReservationSnapshot }} [options] */
  constructor({ holdings = [], snapshot } = {}) {
    requireThat(Array.isArray(holdings));
    if (snapshot !== undefined) {
      requireThat(holdings.length === 0 && snapshot && snapshot.schema === 'kai-reservation-store.v1'
        && Array.isArray(snapshot.holdings) && Array.isArray(snapshot.totals) && Array.isArray(snapshot.entries));
    }
    for (const holding of snapshot?.holdings ?? holdings) {
      validateHolding(holding);
      const key = keyOf(holding.accountId, holding.holdingId);
      requireThat(!this.#holdings.has(key));
      this.#holdings.set(key, clone(holding));
      this.#totals.set(key, holding.unitsRemaining);
    }
    if (snapshot !== undefined) this.#restore(snapshot);
  }

  /** @param {ReservationSnapshot} snapshot */
  #restore(snapshot) {
    /** @type {Map<string, ReservationSnapshot['totals'][number]>} */
    const totals = new Map();
    for (const total of snapshot.totals) {
      requireThat(total && text(total.accountId) && text(total.holdingId) && integer(total.total) && integer(total.reserved));
      const key = keyOf(total.accountId, total.holdingId);
      requireThat(this.#holdings.has(key) && !totals.has(key));
      totals.set(key, total);
      this.#totals.set(key, total.total);
    }
    requireThat(totals.size === this.#holdings.size);
    for (const entry of snapshot.entries) {
      const holding = this.#holdings.get(keyOf(entry?.accountId, entry?.binding?.holdingId));
      validateEntry(entry, holding);
      const identity = keyOf(entry.accountId, entry.idempotencyKey);
      requireThat(!this.#entries.has(identity));
      this.#entries.set(identity, clone(entry));
    }
    for (const [key, holding] of this.#holdings) {
      const balance = totals.get(key);
      if (!balance) throw new Error('RESERVATION_INVALID');
      const reserved = this.#reserved(holding.accountId, holding.holdingId);
      const committed = [...this.#entries.values()].filter((entry) => entry.accountId === holding.accountId
        && entry.binding.holdingId === holding.holdingId && committedStates.includes(entry.state));
      const spent = committed.reduce((sum, entry) => sum + entry.units, 0);
      requireThat(integer(reserved) && reserved === balance.reserved && reserved <= holding.unitsRemaining
        && integer(spent) && holding.unitsRemaining + spent === balance.total);
      // Each successful commit has one distinct post-debit balance; this also
      // validates historical Holding snapshots used to rebuild Receipts.
      const remaining = committed.map((entry) => entry.holding?.unitsRemaining).sort((left, right) => Number(right) - Number(left));
      requireThat(remaining.every((value, index) => value === balance.total - index - 1));
    }
  }

  /** @param {ReserveCommand} command */
  reserve(command) {
    requireThat(command && text(command.accountId) && text(command.idempotencyKey) && text(command.requestHash)
      && text(command.ownerToken) && command.units === 1 && Number.isFinite(time(command.at)));
    const identity = keyOf(command.accountId, command.idempotencyKey);
    const previous = this.#entries.get(identity);
    if (previous) {
      requireThat(previous.requestHash === command.requestHash && previous.units === command.units
        && same(previous.binding, command.binding), 'IDEMPOTENCY_CONFLICT');
      return { acquired: false, entry: clone(previous) };
    }
    const holding = this.#holdings.get(keyOf(command.accountId, command.binding?.holdingId));
    if (!holding || !bindingMatches(command.binding, holding)) throw new Error('HOLDING_REQUIRED');
    requireThat(time(holding.slot.slotStart) <= time(command.at) && time(command.at) < time(holding.slot.slotEnd), 'SLOT_NOT_ACTIVE');
    const reserved = this.#reserved(command.accountId, holding.holdingId);
    requireThat(holding.unitsRemaining - reserved >= command.units, 'HOLDING_EXHAUSTED');
    requireThat(['held', 'active'].includes(holding.status), 'HOLDING_REQUIRED');
    /** @type {ReservationEntry} */
    const entry = {
      accountId: command.accountId, idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
      binding: clone(command.binding), units: command.units, state: 'reserved', ownerToken: command.ownerToken, reservedAt: command.at,
    };
    this.#entries.set(identity, entry);
    return { acquired: true, entry: clone(entry) };
  }

  /** @param {MoveCommand} command */
  move(command) {
    requireThat(command && text(command.accountId) && text(command.idempotencyKey) && text(command.ownerToken));
    const identity = keyOf(command.accountId, command.idempotencyKey);
    const entry = this.#entries.get(identity);
    if (!entry || entry.ownerToken !== command.ownerToken || !Object.hasOwn(transitions, command.from)
      || !transitions[command.from].includes(command.to)) {
      throw new Error('RESERVATION_CONFLICT');
    }
    requireThat((command.to === 'provider_succeeded' || command.providerResult === undefined)
      && (receiptStates.includes(command.to) || command.receipt === undefined));
    if (entry.state === command.to) {
      requireThat((command.to !== 'provider_succeeded' || same(entry.providerResult, command.providerResult))
        && (!receiptStates.includes(command.to) || same(entry.receipt, command.receipt)), 'RESERVATION_CONFLICT');
      return clone(entry);
    }
    requireThat(entry.state === command.from, 'RESERVATION_CONFLICT');
    /** @type {ReservationEntry} */
    let next = { ...entry, state: command.to };
    if (command.to === 'provider_succeeded') {
      validateResult(command.providerResult);
      next = { ...next, providerResult: clone(command.providerResult) };
    }
    if (command.to === 'committed') {
      const key = keyOf(entry.accountId, entry.binding.holdingId);
      const holding = this.#holdings.get(key);
      if (!holding || holding.unitsRemaining < entry.units) throw new Error('RESERVATION_CONFLICT');
      const unitsRemaining = holding.unitsRemaining - entry.units;
      const updated = { ...holding, unitsRemaining, status: /** @type {Holding['status']} */ (unitsRemaining === 0 ? 'exhausted' : 'active') };
      next = { ...next, holding: clone(updated) };
      this.#holdings.set(key, updated);
    }
    if (receiptStates.includes(command.to)) {
      validateReceipt(command.receipt, entry);
      if (command.to === 'receipt_committed') requireThat(same(entry.receipt, command.receipt), 'RESERVATION_CONFLICT');
      next = { ...next, receipt: clone(command.receipt) };
    }
    this.#entries.set(identity, next);
    return clone(next);
  }

  /** @param {string} accountId @param {string} holdingId */
  #reserved(accountId, holdingId) {
    let reserved = 0;
    for (const entry of this.#entries.values()) {
      if (entry.accountId === accountId && entry.binding.holdingId === holdingId && isReserved(entry)) reserved += entry.units;
    }
    return reserved;
  }

  /** @param {string} accountId @param {string} holdingId */
  getHolding(accountId, holdingId) {
    return clone(this.#holdings.get(keyOf(accountId, holdingId)));
  }

  /** @param {string} accountId @param {string} holdingId */
  inspect(accountId, holdingId) {
    const key = keyOf(accountId, holdingId);
    const holding = this.#holdings.get(key);
    if (!holding) throw new Error('HOLDING_REQUIRED');
    const total = this.#totals.get(key);
    if (total === undefined) throw new Error('RESERVATION_INVALID');
    const reserved = this.#reserved(accountId, holdingId);
    return { total, available: holding.unitsRemaining - reserved, reserved, committed: total - holding.unitsRemaining };
  }

  /** Private reconstruction data, including Provider output; never public evidence. @returns {ReservationSnapshot} */
  snapshot() {
    return clone({
      schema: 'kai-reservation-store.v1', holdings: [...this.#holdings.values()],
      totals: [...this.#holdings.entries()].map(([key, holding]) => ({
        accountId: holding.accountId, holdingId: holding.holdingId, total: this.#totals.get(key) ?? -1,
        reserved: this.#reserved(holding.accountId, holding.holdingId),
      })),
      entries: [...this.#entries.values()],
    });
  }
}
