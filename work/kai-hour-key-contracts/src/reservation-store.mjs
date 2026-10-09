import { ReservationStateMachine } from './reservation-state.mjs';
/** @typedef {import('../ports/reservations.js').ReservationStorePort} ReservationStorePort */

/** In-process adapter; async surface matches persistent adapters.
 * @implements {ReservationStorePort}
 */
export class MemoryReservationStore {
  #state;
  /** @param {ConstructorParameters<typeof ReservationStateMachine>[0]} [options] */
  constructor(options) { this.#state = new ReservationStateMachine(options); }
  /** @param {import('../ports/reservations.js').ReserveCommand} command */
  async reserve(command) { return this.#state.reserve(command); }
  /** @param {import('../ports/reservations.js').MoveReservationCommand} command */
  async move(command) { return this.#state.move(command); }
  /** @param {string} accountId @param {string} holdingId */
  async getHolding(accountId, holdingId) { return this.#state.getHolding(accountId, holdingId); }
  /** @param {string} accountId @param {string} holdingId */
  async inspect(accountId, holdingId) { return this.#state.inspect(accountId, holdingId); }
  snapshot() { return this.#state.snapshot(); }
}
