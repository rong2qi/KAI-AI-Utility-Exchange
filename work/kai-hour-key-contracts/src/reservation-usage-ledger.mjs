import { createHash, randomUUID } from 'node:crypto';

const bindingFields = ['keyId', 'grantId', 'holdingId', 'offerId', 'model', 'provider', 'region'];
const resultOf = (entry) => structuredClone({ receipt: entry.receipt, output: entry.providerResult.output });
const keyOf = (command) => JSON.stringify([command.accountId, command.idempotencyKey]);

function validResult(result) {
  if (result?.status !== 'succeeded' || !Object.hasOwn(result, 'output') || result.output === undefined
    || typeof result.providerRequestId !== 'string' || !result.providerRequestId) return false;
  const { inputUnits, outputUnits, totalUnits } = result.usage ?? {};
  if (![inputUnits, outputUnits, totalUnits].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  if (inputUnits + outputUnits !== totalUnits) return false;
  try { JSON.stringify(result); structuredClone(result); } catch { return false; }
  return true;
}

/**
 * One shared store owns execution claims and Holding reservations atomically.
 * Provider I/O is outside its transactions. Unknown outcomes stay reserved.
 */
export class ReservationUsageLedger {
  constructor({ store } = {}) {
    if (typeof store?.reserve !== 'function' || typeof store?.move !== 'function') throw new Error('RESERVATION_STORE_REQUIRED');
    this.store = store;
  }

  get admissionMode() { return 'atomic-reservation'; }

  async execute(command) { return (await this.executeWithResult(command)).receipt; }

  async executeWithResult(command) {
    if (typeof command?.providerAdapter?.execute !== 'function' || typeof command?.receiptWriter?.append !== 'function'
      || typeof command?.buildReceipt !== 'function') throw new Error('EXECUTION_COMMAND_INVALID');
    const { acquired, entry: initial } = await this.store.reserve({
      accountId: command.accountId, idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
      binding: Object.fromEntries(bindingFields.map((field) => [field, command[field]])),
      units: 1, at: command.at, ownerToken: randomUUID(),
    });
    let entry = initial;
    if (entry.state === 'receipt_committed') return resultOf(entry);
    if (entry.state === 'released') throw new Error('EXECUTION_RELEASED');
    if (entry.state === 'uncertain') throw new Error('EXECUTION_UNCERTAIN');
    if (!acquired && ['reserved', 'dispatching'].includes(entry.state)) throw new Error('EXECUTION_IN_PROGRESS');
    const move = async (to, payload = {}) => {
      entry = await this.store.move({ accountId: command.accountId, idempotencyKey: command.idempotencyKey,
        ownerToken: entry.ownerToken, from: entry.state, to, ...payload });
    };
    const preflight = async () => {
      try { await command.beforeProviderExecution?.(); }
      catch (error) {
        // Only this path proves the adapter has not yet been invoked.
        try { await move('released'); } catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
        throw error;
      }
    };
    if (acquired) {
      await preflight();
      try { await move('dispatching'); } catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
      // A store write may cross an hour boundary; recheck after all admission I/O.
      await preflight();
      let providerResult;
      try {
        providerResult = await command.providerAdapter.execute({
          model: command.model, region: command.region, input: command.providerInput, requestId: command.requestId,
          idempotencyKey: 'kai_' + createHash('sha256').update(keyOf(command)).digest('hex'),
        });
        if (!validResult(providerResult)) throw new Error('PROVIDER_RESULT_INVALID');
      } catch {
        // Failure to persist uncertainty still leaves a dispatch marker; never release or resend.
        try { await move('uncertain'); } catch { /* dispatch state continues to reserve the unit */ }
        throw new Error('EXECUTION_UNCERTAIN');
      }
      try { await move('provider_succeeded', { providerResult: structuredClone(providerResult) }); }
      catch { throw new Error('EXECUTION_UNCERTAIN'); }
    }
    if (entry.state === 'provider_succeeded') {
      try { await move('committed'); } catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
    }
    if (entry.state === 'committed') {
      try {
        await move('receipt_prepared', { receipt: command.buildReceipt({
          providerResult: structuredClone(entry.providerResult), holding: structuredClone(entry.holding),
        }) });
      } catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
    }
    if (entry.state === 'receipt_prepared') {
      let receipt;
      try { receipt = await command.receiptWriter.append(structuredClone(entry.receipt)); }
      catch { throw new Error('RECEIPT_WRITE_FAILED'); }
      try { await move('receipt_committed', { receipt: structuredClone(receipt) }); }
      catch { throw new Error('EXECUTION_LEDGER_FAILED'); }
    }
    if (entry.state !== 'receipt_committed') throw new Error('EXECUTION_LEDGER_FAILED');
    return resultOf(entry);
  }
}
