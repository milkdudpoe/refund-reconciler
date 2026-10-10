// In-memory storage fakes for the service-worker handler (disclosed test
// setup: these replace chrome.storage.local / chrome.storage.session, nothing
// else). Cryptography is never faked: the handler uses real WebCrypto.

import { createHandler, type Handler } from '../../src/background/handler';
import type { StorageAreaLike } from '../../src/persistence/storage';

export type Op = { area: string; type: 'get' | 'set' | 'remove' | 'bytes'; keys: string[] };
/** reject: the call fails and nothing is applied. hang: never settles (the worker is "killed" there). commit-hang: applied, then never settles. */
export type Fault = 'reject' | 'hang' | 'commit-hang';

export class FakeArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  log: Op[];
  fault: ((op: Op) => Fault | undefined) | null = null;
  quotaBytes?: number;

  constructor(
    readonly name: string,
    log: Op[] = [],
  ) {
    this.log = log;
  }

  private async run<T>(op: Op, apply: () => T): Promise<T> {
    this.log.push(op);
    await Promise.resolve();
    const f = this.fault?.(op);
    if (f === 'reject') throw new Error(`Simulated ${this.name}.${op.type} failure`);
    if (f === 'hang') return new Promise<T>(() => undefined);
    const result = apply();
    if (f === 'commit-hang') return new Promise<T>(() => undefined);
    return result;
  }

  get(keys: string | string[]) {
    const list = typeof keys === 'string' ? [keys] : keys;
    return this.run({ area: this.name, type: 'get', keys: list }, () => {
      const out: Record<string, unknown> = {};
      for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
      return out;
    });
  }
  set(items: Record<string, unknown>) {
    return this.run({ area: this.name, type: 'set', keys: Object.keys(items) }, () => {
      for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
    });
  }
  remove(keys: string | string[]) {
    const list = typeof keys === 'string' ? [keys] : keys;
    return this.run({ area: this.name, type: 'remove', keys: list }, () => {
      for (const k of list) this.data.delete(k);
    });
  }
  getBytesInUse(): Promise<number> {
    return this.run({ area: this.name, type: 'bytes', keys: [] }, () => {
      let n = 0;
      for (const [k, v] of this.data) n += k.length + JSON.stringify(v).length;
      return n;
    });
  }
}

export const PHRASE = 'synthetic test phrase 0001';

export interface World {
  log: Op[];
  local: FakeArea;
  session: FakeArea;
  access: { fail: boolean };
  broadcasts: number;
  handler: Handler;
  /** A new handler on the same storage, as after the service worker was stopped and started again. */
  restartWorker(): void;
  /** Clears session storage and restarts the worker, as after a browser restart or extension reload/update. */
  restartBrowser(): void;
  send<T = Record<string, any>>(msg: unknown): Promise<T>;
}

let clock = 0;
export function testNow(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 1, 0, 0, clock)).toISOString();
}

export function makeWorld(): World {
  const log: Op[] = [];
  const local = new FakeArea('local', log);
  const session = new FakeArea('session', log);
  const access = { fail: false };
  const world: World = {
    log,
    local,
    session,
    access,
    broadcasts: 0,
    handler: null as unknown as Handler,
    restartWorker() {
      world.handler = createHandler({
        local,
        session,
        ensureAccess: async () => {
          if (access.fail) throw new Error('Simulated setAccessLevel failure');
        },
        now: testNow,
        broadcast: () => {
          world.broadcasts += 1;
        },
      });
    },
    restartBrowser() {
      session.data.clear();
      world.restartWorker();
    },
    send: (msg) => world.handler.handle(msg) as Promise<never>,
  };
  world.restartWorker();
  return world;
}

export async function setUp(world: World, phrase = PHRASE): Promise<void> {
  const res = await world.send({ kind: 'setup', passphrase: phrase, acknowledged: true });
  if (!res.ok) throw new Error(`setup failed: ${JSON.stringify(res)}`);
}

export async function readLedger(world: World): Promise<any> {
  const res = await world.send<{ ok: boolean; ledger: any }>({ kind: 'read' });
  if (!res.ok) throw new Error('read failed');
  return res.ledger;
}

export async function storedStore(world: World): Promise<any> {
  const ledger = await readLedger(world);
  if (ledger.status !== 'ok') throw new Error(`ledger is ${ledger.status}`);
  return ledger.store;
}

/** Waits until queued microtasks and timers have run (for "hang" faults). */
export const settle = () => new Promise((r) => setTimeout(r, 20));
