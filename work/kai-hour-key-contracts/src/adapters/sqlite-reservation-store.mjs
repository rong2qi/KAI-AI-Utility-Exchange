import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { ReservationStateMachine, canonicalReservationValue } from '../reservation-state.mjs';

const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x4b414931;
const SQL = `
  CREATE TABLE holdings (
    account_id TEXT NOT NULL, holding_id TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
    PRIMARY KEY(account_id, holding_id)
  ) STRICT;
  CREATE TABLE claims (
    account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, holding_id TEXT NOT NULL,
    PRIMARY KEY(account_id, idempotency_key),
    FOREIGN KEY(account_id, holding_id) REFERENCES holdings(account_id, holding_id)
  ) STRICT;
  CREATE TABLE receipts (
    account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, receipt_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    PRIMARY KEY(account_id, idempotency_key), UNIQUE(account_id, receipt_id),
    FOREIGN KEY(account_id, idempotency_key) REFERENCES claims(account_id, idempotency_key)
  ) STRICT;
`;

function encode(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || canonicalReservationValue(value) !== canonicalReservationValue(JSON.parse(encoded))) {
    throw new Error('RESERVATION_JSON_LOSS');
  }
  return encoded;
}

function privateFile(path, create) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('DATABASE_PATH_INVALID');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
    || parent.uid !== process.getuid()) throw new Error('DATABASE_DIRECTORY_NOT_PRIVATE');
  if (!create) {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0
      || file.uid !== process.getuid()) throw new Error('DATABASE_FILE_NOT_PRIVATE');
  }
  try {
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('DATABASE_EXISTS', { cause: error });
    throw new Error('DATABASE_OPEN_FAILED', { cause: error });
  }
}

/** Local-disk SQL adapter. Shared rules execute synchronously inside short SQL
 * transactions. Never put Provider I/O, callbacks or await inside #transaction.
 * Node >=22.13 with node:sqlite; one local host, no network filesystem.
 */
export class SqliteReservationStore {
  #db;
  constructor({ path, holdings, busyTimeoutMs = 2000 } = {}) {
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('DATABASE_PLATFORM_UNSUPPORTED');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new Error('DATABASE_TIMEOUT_INVALID');
    // Validate all seed facts before creating a file. Supplying seeds always means create-only.
    const seed = holdings === undefined ? undefined : new ReservationStateMachine({ holdings }).snapshot();
    if (seed && seed.holdings.length === 0) throw new Error('DATABASE_SEED_REQUIRED');
    privateFile(path, seed !== undefined);
    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`);
      if (!seed && (this.#db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION
        || this.#db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID)) throw new Error('DATABASE_SCHEMA_UNSUPPORTED');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (this.#db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal'
        || this.#db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('DATABASE_DURABILITY_REQUIRED');
      if (seed) this.#transaction(() => {
        this.#db.exec(SQL);
        for (const holding of seed.holdings) {
          const state = new ReservationStateMachine({ holdings: [holding] }).snapshot();
          this.#db.prepare('INSERT INTO holdings VALUES (?, ?, ?)').run(holding.accountId, holding.holdingId, encode(state));
        }
        this.#db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      });
    } catch (error) {
      this.close(); throw error;
    }
  }

  #transaction(action, write = true) {
    if (!this.#db) throw new Error('DATABASE_CLOSED');
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // A failed rollback poisons the connection; it must never be reused.
      try { this.#db.exec('ROLLBACK'); } catch { this.close(); }
      throw error;
    }
  }

  #claim(accountId, idempotencyKey) {
    return this.#db.prepare('SELECT holding_id FROM claims WHERE account_id=? AND idempotency_key=?').get(accountId, idempotencyKey);
  }

  #load(accountId, holdingId) {
    const row = this.#db.prepare('SELECT state_json FROM holdings WHERE account_id=? AND holding_id=?').get(accountId, holdingId);
    if (!row) throw new Error('HOLDING_REQUIRED');
    const state = JSON.parse(row.state_json);
    if (state.holdings?.length !== 1 || state.holdings[0].accountId !== accountId || state.holdings[0].holdingId !== holdingId) {
      throw new Error('RESERVATION_INVALID');
    }
    const claims = this.#db.prepare('SELECT idempotency_key FROM claims WHERE account_id=? AND holding_id=?').all(accountId, holdingId);
    const ids = new Set(claims.map((claim) => claim.idempotency_key));
    if (!Array.isArray(state.entries) || ids.size !== state.entries.length || state.entries.some((entry) => !ids.has(entry.idempotencyKey))) {
      throw new Error('RESERVATION_INVALID');
    }
    const machine = new ReservationStateMachine({ snapshot: state });
    const receipts = new Map(this.#db.prepare(`SELECT r.idempotency_key, r.receipt_id, r.receipt_json FROM receipts r
      JOIN claims c ON c.account_id=r.account_id AND c.idempotency_key=r.idempotency_key
      WHERE c.account_id=? AND c.holding_id=?`).all(accountId, holdingId).map((row) => [row.idempotency_key, row]));
    for (const entry of state.entries) {
      const row = receipts.get(entry.idempotencyKey);
      if (entry.state === 'receipt_committed' && !row) throw new Error('RESERVATION_INVALID');
      if (row && (!['receipt_prepared', 'receipt_committed'].includes(entry.state)
        || row.receipt_id !== entry.receipt?.receiptId
        || canonicalReservationValue(JSON.parse(row.receipt_json)) !== canonicalReservationValue(entry.receipt))) throw new Error('RESERVATION_INVALID');
    }
    return machine;
  }

  #save(accountId, holdingId, state) {
    this.#db.prepare('UPDATE holdings SET state_json=? WHERE account_id=? AND holding_id=?').run(encode(state.snapshot()), accountId, holdingId);
  }

  async reserve(command) {
    return this.#transaction(() => {
      const previous = this.#claim(command.accountId, command.idempotencyKey);
      const holdingId = previous?.holding_id ?? command.binding?.holdingId;
      const state = this.#load(command.accountId, holdingId);
      const result = state.reserve(command);
      if (result.acquired) {
        this.#db.prepare('INSERT INTO claims VALUES (?, ?, ?)').run(command.accountId, command.idempotencyKey, holdingId);
        this.#save(command.accountId, holdingId, state);
      }
      return result;
    });
  }

  async move(command) {
    return this.#transaction(() => {
      const claim = this.#claim(command.accountId, command.idempotencyKey);
      if (!claim) throw new Error('RESERVATION_CONFLICT');
      const state = this.#load(command.accountId, claim.holding_id);
      const result = state.move(command);
      if (command.to === 'receipt_committed') {
        const row = this.#db.prepare('SELECT receipt_json FROM receipts WHERE account_id=? AND idempotency_key=?').get(command.accountId, command.idempotencyKey);
        if (!row || canonicalReservationValue(JSON.parse(row.receipt_json)) !== canonicalReservationValue(result.receipt)) throw new Error('RECEIPT_NOT_PERSISTED');
      }
      this.#save(command.accountId, claim.holding_id, state);
      return result;
    });
  }

  async getHolding(accountId, holdingId) {
    return this.#transaction(() => {
      if (!this.#db.prepare('SELECT 1 FROM holdings WHERE account_id=? AND holding_id=?').get(accountId, holdingId)) return undefined;
      return this.#load(accountId, holdingId).getHolding(accountId, holdingId);
    }, false);
  }

  async inspect(accountId, holdingId) {
    return this.#transaction(() => this.#load(accountId, holdingId).inspect(accountId, holdingId), false);
  }

  get receiptWriter() {
    return { append: (receipt) => this.#append(receipt), get: (accountId, receiptId) => this.#getReceipt(accountId, receiptId) };
  }

  async #append(receipt) {
    return this.#transaction(() => {
      const claim = this.#claim(receipt.accountId, receipt.idempotencyKey);
      if (!claim) throw new Error('RECEIPT_NOT_PREPARED');
      const state = this.#load(receipt.accountId, claim.holding_id);
      const entry = state.snapshot().entries.find((entry) => entry.idempotencyKey === receipt.idempotencyKey);
      if (!['receipt_prepared', 'receipt_committed'].includes(entry?.state)) throw new Error('RECEIPT_NOT_PREPARED');
      if (canonicalReservationValue(entry.receipt) !== canonicalReservationValue(receipt)) throw new Error('IDEMPOTENCY_CONFLICT');
      const existing = this.#db.prepare('SELECT receipt_json FROM receipts WHERE account_id=? AND idempotency_key=?').get(receipt.accountId, receipt.idempotencyKey);
      if (existing) {
        if (canonicalReservationValue(JSON.parse(existing.receipt_json)) !== canonicalReservationValue(receipt)) throw new Error('IDEMPOTENCY_CONFLICT');
        return JSON.parse(existing.receipt_json);
      }
      if (this.#db.prepare('SELECT 1 FROM receipts WHERE account_id=? AND receipt_id=?').get(receipt.accountId, receipt.receiptId)) throw new Error('IDEMPOTENCY_CONFLICT');
      this.#db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)').run(receipt.accountId, receipt.idempotencyKey, receipt.receiptId, encode(receipt));
      return structuredClone(receipt);
    });
  }

  async #getReceipt(accountId, receiptId) {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT receipt_json FROM receipts WHERE account_id=? AND receipt_id=?').get(accountId, receiptId);
      if (!row) return undefined;
      const receipt = JSON.parse(row.receipt_json);
      const claim = this.#claim(accountId, receipt.idempotencyKey);
      const state = claim && this.#load(accountId, claim.holding_id);
      const entry = state?.snapshot().entries.find((entry) => entry.idempotencyKey === receipt.idempotencyKey);
      if (receipt.accountId !== accountId || receipt.receiptId !== receiptId || !entry?.receipt
        || canonicalReservationValue(entry.receipt) !== canonicalReservationValue(receipt)) throw new Error('RESERVATION_INVALID');
      return receipt;
    }, false);
  }

  close() {
    const db = this.#db; this.#db = undefined;
    if (db) db.close();
  }
}
