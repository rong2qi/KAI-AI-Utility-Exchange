import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteReservationStore } from '../../src/adapters/sqlite-reservation-store.mjs';
import { ReservationUsageLedger } from '../../src/reservation-usage-ledger.mjs';
import { reservation, execution, success } from './sqlite-reservation-fixture.mjs';

const [path, mode, id, phase, trace] = process.argv.slice(2);
const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
const pause = async () => { await send({ kind: 'checkpoint' }); await new Promise(() => {}); };
// Parent owns cleanup and may SIGKILL this process at an observed durable checkpoint.
process.once('message', async () => {
  let store;
  try {
    if (mode === 'uncommitted') {
      const db = new DatabaseSync(path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE holdings SET state_json='{}'").run();
      await pause();
      return;
    }
    store = new SqliteReservationStore({ path });
    if (mode === 'reserve') {
      const result = await store.reserve({ ...reservation(id), ownerToken: `worker-${process.pid}` });
      await send({ kind: 'result', acquired: result.acquired });
    } else {
      const wrapped = {
        reserve: async (command) => { const result = await store.reserve(command); if (phase === 'reserved') await pause(); return result; },
        move: async (command) => { const result = await store.move(command); if (command.to === phase) await pause(); return result; },
      };
      const command = execution(store, async () => {
        appendFileSync(trace, 'provider-call\n', { mode: 0o600 });
        if (phase === 'provider_return') await pause();
        if (phase === 'uncertain') throw new Error('SYNTHETIC_NETWORK_FAILURE');
        return success;
      }, id);
      const append = command.receiptWriter.append;
      command.receiptWriter.append = async (receipt) => {
        const result = await append(receipt);
        if (phase === 'receipt_written') await pause();
        return result;
      };
      const result = await new ReservationUsageLedger({ store: wrapped }).executeWithResult(command);
      await send({ kind: 'result', receiptId: result.receipt.receiptId });
    }
  } catch (error) {
    await send({ kind: 'result', error: error.message });
  } finally {
    store?.close(); process.disconnect();
  }
});
await send({ kind: 'ready' });
