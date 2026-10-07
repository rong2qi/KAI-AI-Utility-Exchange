import { createHash } from 'node:crypto';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const keyOf = (accountId, idempotencyKey) => JSON.stringify([accountId, idempotencyKey]);
const resultOf = (entry) => ({ receipt: clone(entry.receipt), output: clone(entry.providerResult?.output) });
const bindingFields = ['keyId', 'grantId', 'holdingId', 'offerId', 'model', 'provider', 'region'];
const bindingOf = (command) => Object.fromEntries(bindingFields.map((field) => [field, command[field]]));

export const USAGE_EXECUTION_STATES = Object.freeze([
  'started',
  'provider_succeeded',
  'holding_consumed',
  'receipt_committed',
]);

/** Local test store. Deployment must provide a transactional row/ledger store. */
export class MemoryUsageExecutionLedgerStore {
  constructor(entries = []) {
    this.entries = new Map(entries.map((entry) => [keyOf(entry.accountId, entry.idempotencyKey), clone(entry)]));
  }

  async get(accountId, idempotencyKey) {
    return clone(this.entries.get(keyOf(accountId, idempotencyKey)));
  }

  async save(entry) {
    const key = keyOf(entry.accountId, entry.idempotencyKey);
    const existing = this.entries.get(key);
    if (existing && existing.requestHash !== entry.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
    this.entries.set(key, clone(entry));
    return clone(entry);
  }
}

/**
 * Resumable usage settlement. External Provider calls are only deduplicated when
 * the upstream honors the idempotencyKey; local state prevents repeated Holding
 * consumption and Receipt writes after a recorded state transition.
 */
export class UsageExecutionLedger {
  constructor({ store = new MemoryUsageExecutionLedgerStore() } = {}) {
    this.store = store;
    this.locks = new Map();
  }

  async execute(command) {
    return (await this.executeWithResult(command)).receipt;
  }

  /** Private application result; the public Receipt never contains Provider output. */
  async executeWithResult(command) {
    if (!command?.accountId || !command.idempotencyKey || !command.requestHash) throw new Error('EXECUTION_COMMAND_INVALID');
    if (!command.providerAdapter || !command.holdingPort || !command.receiptWriter || !command.buildReceipt) {
      throw new Error('EXECUTION_COMMAND_INVALID');
    }
    const key = keyOf(command.accountId, command.idempotencyKey);
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, gate);
    await previous;
    try {
      return await this.#executeUnlocked(command);
    } finally {
      release();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }

  async #executeUnlocked(command) {
    let entry = await this.store.get(command.accountId, command.idempotencyKey);
    if (entry && entry.requestHash !== command.requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
    if (entry && bindingFields.some((field) => entry.binding?.[field] !== command[field])) throw new Error('IDEMPOTENCY_CONFLICT');
    if (!entry) {
      entry = {
        accountId: command.accountId,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        binding: bindingOf(command),
        state: 'started',
      };
      await this.store.save(entry);
    }
    if (!USAGE_EXECUTION_STATES.includes(entry.state)) throw new Error('EXECUTION_LEDGER_CORRUPT');
    if (entry.state === 'receipt_committed') return resultOf(entry);

    if (entry.state === 'started') {
      await command.beforeProviderExecution?.();
      let providerResult;
      try {
        providerResult = await command.providerAdapter.execute({
          model: command.model,
          region: command.region,
          input: command.providerInput,
          requestId: command.requestId,
          idempotencyKey: 'kai_' + createHash('sha256').update(keyOf(command.accountId, command.idempotencyKey)).digest('hex'),
        });
      } catch {
        throw new Error('PROVIDER_UNAVAILABLE');
      }
      if (providerResult?.status !== 'succeeded') throw new Error('PROVIDER_UNAVAILABLE');
      entry = { ...entry, state: 'provider_succeeded', providerResult: clone(providerResult) };
      await this.store.save(entry);
    }

    if (entry.state === 'provider_succeeded') {
      let holding;
      try {
        holding = await command.holdingPort.consume({
          accountId: command.accountId,
          holdingId: command.holdingId,
          units: 1,
          at: command.at,
          idempotencyKey: command.idempotencyKey,
        });
      } catch (error) {
        throw new Error(error?.message === 'HOLDING_EXHAUSTED' ? 'HOLDING_EXHAUSTED' : 'HOLDING_REQUIRED', { cause: error });
      }
      entry = { ...entry, state: 'holding_consumed', holding: clone(holding) };
      await this.store.save(entry);
    }

    if (entry.state === 'holding_consumed') {
      let receipt;
      try {
        receipt = await command.receiptWriter.append(command.buildReceipt({
          providerResult: clone(entry.providerResult),
          holding: clone(entry.holding),
        }));
      } catch (error) {
        if (error?.message === 'IDEMPOTENCY_CONFLICT') throw error;
        throw new Error('RECEIPT_WRITE_FAILED', { cause: error });
      }
      entry = { ...entry, state: 'receipt_committed', receipt: clone(receipt) };
      await this.store.save(entry);
    }

    return resultOf(entry);
  }
}
