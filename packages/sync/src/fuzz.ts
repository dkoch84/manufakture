import {
  checkDocument,
  serialize,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
// Test-only: core's random command streams (ported from the T7.0b spike's generator and widened
// to every counter scope), imported from its source since core does not export it.
import { Generator, Rng } from '../../core/src/sync-test-generator';
import { SyncClient, type SubmitInput } from './client';
import type { ClientMessage, ServerMessage } from './protocol';
import { ReferenceServer } from './server';

/**
 * Test-only: the fuzz harness. Clients, the reference server and a network on a virtual clock
 * driven by a seeded event queue, with the faults of the T7.1b plan: lost submits (retried after a
 * timeout), lost acks and refusals, duplicated deliveries, independently delayed (so reordered)
 * submits, a push stream running behind the server's head, an offline stretch, and a save and
 * restore of a client's queue state at random steps.
 *
 * Every client runs as a pair: `main` is never saved; `twin` gets the same inputs and is rebuilt
 * from its own saved state (through JSON) at random steps. After every input the two must have the
 * same saved state, the same shown document and the same outgoing messages: a restored client
 * behaves exactly like one that was never saved. Not exported.
 */

export interface Scenario {
  readonly name: string;
  readonly clients: number;
  readonly commandsPerClient: number;
  /** Mean time between one client's actions (virtual ms). */
  readonly think: number;
  /** Mean one-way latency; each message gets its own random delay. */
  readonly latency: number;
  /** Probability that a submit, or a verdict (ack, refusal, predecessor-unknown), is lost. */
  readonly loss?: number;
  /** Probability that a delivery happens twice. */
  readonly duplicate?: number;
  /** Extra mean delay of pushes: the push stream runs behind the server's head. */
  readonly pushDelay?: number;
  /** Each client's submits arrive in the order sent (one ordered channel). */
  readonly fifo?: boolean;
  /** Client 0 is offline in [from, to). */
  readonly offline?: { readonly from: number; readonly to: number };
  /** Probabilities that an action is an undo, a redo, or a restore of a past version. */
  readonly undo?: number;
  readonly redo?: number;
  readonly restore?: number;
  /** Probability, after each input, that the twin is saved and restored. */
  readonly saveRestore?: number;
  /** Keep the generator's own restores (`replaceDocument`, as restore intents). */
  readonly generatorRestores?: boolean;
}

export interface RunResult {
  readonly scenario: string;
  readonly seed: number;
  readonly made: number;
  readonly landed: number;
  readonly dropped: number;
  readonly withdrawn: number;
  readonly accepted: number;
  readonly remaps: number;
  readonly restores: number;
  readonly undos: number;
  /** Times a twin was rebuilt from its saved state. */
  readonly twinRestores: number;
  readonly converged: boolean;
  readonly stuck: boolean;
  /** Broken invariants (should stay empty). */
  readonly violations: string[];
}

interface Event {
  at: number;
  seq: number;
  run: () => void;
}

/** A binary heap of events by (time, insertion order). */
class Events {
  private readonly heap: Event[] = [];
  private seq = 0;
  push(at: number, run: () => void): void {
    const h = this.heap;
    h.push({ at, seq: this.seq++, run });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  pop(): Event | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less(a: Event, b: Event): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

const MAX_EVENTS = 400_000;
const AT = '2026-10-04T12:00:00.000Z';

/** The confirmed document as an app would store it beside the state: plain JSON. */
function roundTrip(doc: ManufaktureDocument): ManufaktureDocument {
  const back = JSON.parse(JSON.stringify(doc)) as ManufaktureDocument;
  const c = checkDocument(back);
  if (!c.ok) throw new Error(`the confirmed document does not load: ${c.error.message}`);
  return back;
}

interface Slot {
  main: SyncClient;
  twin: SyncClient;
  readonly gen: Generator;
  readonly history: ManufaktureDocument[];
  remaining: number;
  online: boolean;
  readonly inbox: ServerMessage[];
}

export function runScenario(sc: Scenario, seed: number, start: ManufaktureDocument): RunResult {
  const rng = new Rng(seed);
  const exp = (mean: number) => (mean <= 0 ? 0 : -Math.log(1 - rng.next()) * mean);
  const events = new Events();
  let now = 0;
  const server = new ReferenceServer(start);
  const violations: string[] = [];
  const slots: Slot[] = [];
  const lastSubmit: number[] = [];
  let restores = 0;
  let undos = 0;
  let twinRestores = 0;
  const loss = sc.loss ?? 0;
  const dup = sc.duplicate ?? 0;
  const isOffline = (i: number) =>
    i === 0 && sc.offline !== undefined && now >= sc.offline.from && now < sc.offline.to;

  const check = (i: number, what: string) => {
    const s = slots[i]!;
    const a = JSON.stringify(s.main.save());
    const b = JSON.stringify(s.twin.save());
    if (a !== b) {
      let k = 0;
      while (k < a.length && a[k] === b[k]) k++;
      violations.push(
        `client ${i}: after ${what}, the restored twin's state differs: ...${a.slice(Math.max(0, k - 150), k + 80)} | ${b.slice(Math.max(0, k - 150), k + 80)}`,
      );
    }
    if (serialize(s.main.document) !== serialize(s.twin.document)) {
      violations.push(`client ${i}: after ${what}, the restored twin shows another document`);
    }
  };

  /** Applies one input to both clients of a slot, then maybe rebuilds the twin. */
  const input = <R>(i: number, what: string, f: (c: SyncClient) => R): R => {
    const s = slots[i]!;
    const r = f(s.main);
    const t = f(s.twin);
    if (JSON.stringify(r) !== JSON.stringify(t)) {
      violations.push(`client ${i}: ${what} answered differently on the twin`);
    }
    check(i, what);
    if (rng.chance(sc.saveRestore ?? 0)) {
      const state = JSON.parse(JSON.stringify(s.twin.save())) as unknown;
      const restored = SyncClient.restore(state, roundTrip(s.twin.confirmedDocument), {
        online: s.online,
        now: () => AT,
      });
      if (!restored.ok) violations.push(`client ${i}: restore failed: ${restored.error.message}`);
      else {
        s.twin = restored.value;
        twinRestores++;
        check(i, `${what} and a restore`);
      }
    }
    return r;
  };

  const flush = (i: number, messages = input(i, 'take', (c) => c.takeOutgoing())) => {
    for (const m of messages) toServer(i, m);
  };

  const deliver = (i: number, m: ServerMessage, delay: number) => {
    const at = now + delay;
    const once = () =>
      events.push(at, () => {
        const s = slots[i]!;
        if (!s.online) {
          s.inbox.push(m);
          return;
        }
        const r = input(i, `handle ${m.type}`, (c) => c.handle(JSON.parse(JSON.stringify(m))));
        if (!r.ok) violations.push(`client ${i}: ${m.type} refused: ${r.error.message}`);
        flush(i);
      });
    once();
    if (rng.chance(dup)) events.push(at + exp(sc.latency), () => deliverNow(i, m));
  };

  const deliverNow = (i: number, m: ServerMessage) => {
    const s = slots[i]!;
    if (!s.online) {
      s.inbox.push(m);
      return;
    }
    const r = input(i, `handle ${m.type} again`, (c) => c.handle(JSON.parse(JSON.stringify(m))));
    if (!r.ok) violations.push(`client ${i}: ${m.type} refused: ${r.error.message}`);
    flush(i);
  };

  const toServer = (i: number, m: ClientMessage) => {
    if (!slots[i]!.online) return; // never reaches the network; resent after the timeout
    let at = now + exp(sc.latency);
    if (sc.fifo) at = lastSubmit[i] = Math.max(at, lastSubmit[i] ?? 0);
    const arrive = () => {
      if (m.type !== 'pull' && rng.chance(loss)) return;
      const handled = server.handle(JSON.parse(JSON.stringify(m)));
      for (const reply of handled.replies) {
        if (reply.type === 'error') {
          // A late copy of an entry the client resolved is fine; one it still has in flight is not.
          const inFlight = slots[i]!.main.pending.some(
            (e) => e.clientSeq !== undefined && e.clientSeq === reply.clientSeq,
          );
          if (reply.code !== 'below-floor' || inFlight) {
            violations.push(`server: ${reply.code}: ${reply.message}`);
          }
        }
        const verdict = reply.type !== 'push';
        if (verdict && rng.chance(loss)) continue;
        deliver(i, reply, exp(sc.latency));
      }
      if (handled.push) {
        const c = checkDocument(server.head);
        if (!c.ok) violations.push(`rev ${server.revision}: checkDocument: ${c.error.message}`);
        for (let j = 0; j < slots.length; j++) {
          deliver(j, handled.push, exp(sc.latency) + exp(sc.pushDelay ?? 0));
        }
      }
    };
    events.push(at, arrive);
    if (m.type === 'submit' && rng.chance(dup)) events.push(at + exp(sc.latency), arrive);
  };

  for (let i = 0; i < sc.clients; i++) {
    const make = () => new SyncClient(start, 0, { clientId: `client-${i + 1}`, now: () => AT });
    slots.push({
      main: make(),
      twin: make(),
      gen: new Generator(new Rng(seed * 101 + i + 1)),
      history: [start],
      remaining: sc.commandsPerClient,
      online: true,
      inbox: [],
    });
  }

  const pendingWork = (i: number) => {
    const s = slots[i]!;
    return s.remaining > 0 || s.main.pending.length > 0 || s.inbox.length > 0;
  };

  const act = (i: number) => {
    const s = slots[i]!;
    const offline = isOffline(i);
    if (s.online === offline) {
      s.online = !offline;
      input(i, offline ? 'go offline' : 'go online', (c) => c.setOnline(!offline));
      if (!offline) {
        // Back online: take what arrived meanwhile, then send.
        for (const m of s.inbox.splice(0)) deliverNow(i, m);
      }
    }
    if (s.remaining > 0) {
      s.remaining--;
      const x = rng.next();
      const pUndo = sc.undo ?? 0;
      const pRedo = sc.redo ?? 0;
      const pRestore = sc.restore ?? 0;
      if (x < pUndo) {
        const r = input(i, 'undo', (c) => c.undo());
        if (r.ok) undos++;
      } else if (x < pUndo + pRedo) {
        input(i, 'redo', (c) => c.redo());
      } else if (x < pUndo + pRedo + pRestore) {
        const past = rng.pick(s.history);
        restores++;
        submit(i, { restore: { document: past }, label: 'restore' });
      } else {
        const command = s.gen.generate(s.main.document);
        if (command !== undefined) {
          if (command.type === 'replaceDocument') {
            if (sc.generatorRestores) {
              restores++;
              submit(i, { restore: { document: command.document }, label: 'restore' });
            }
          } else {
            submit(i, { command, label: label(command) });
          }
        }
      }
      flush(i);
    }
    if (pendingWork(i)) events.push(now + exp(sc.think), () => act(i));
  };

  const submit = (i: number, what: SubmitInput) => {
    const r = input(i, `submit ${what.label}`, (c) => c.submit(what));
    if (!r.ok)
      violations.push(
        `client ${i}: a command made on the shown document failed: ${r.error.message}`,
      );
  };

  const timeout = sc.latency * 8;
  const tick = (i: number) => {
    const s = slots[i]!;
    if (s.online)
      flush(
        i,
        input(i, 'retry', (c) => c.retry()),
      );
    if (pendingWork(i)) events.push(now + timeout, () => tick(i));
  };

  for (let i = 0; i < sc.clients; i++) {
    events.push(exp(sc.think), () => act(i));
    events.push(timeout, () => tick(i));
    slots[i]!.main.on('remapped', () => undefined);
  }

  let count = 0;
  let stuck = false;
  for (let e = events.pop(); e; e = events.pop()) {
    now = e.at;
    e.run();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      const doc = s.main.confirmedDocument;
      if (s.history.at(-1) !== doc) {
        s.history.push(doc);
        if (s.history.length > 20) s.history.shift();
      }
    }
    if (++count > MAX_EVENTS) {
      stuck = true;
      break;
    }
  }

  const head = serialize(server.head);
  let converged = !stuck;
  let made = 0;
  let landed = 0;
  let dropped = 0;
  let withdrawn = 0;
  let remaps = 0;
  for (let i = 0; i < slots.length; i++) {
    const c = slots[i]!.main;
    const st = c.stats;
    made += st.made;
    landed += st.landed;
    dropped += st.dropped;
    withdrawn += st.withdrawn;
    remaps += st.remaps;
    if (st.made !== st.landed + st.dropped + st.withdrawn) {
      violations.push(
        `client ${i}: made ${st.made}, landed ${st.landed}, dropped ${st.dropped}, withdrawn ${st.withdrawn}`,
      );
    }
    const inLog = server.log.filter((p) => p.entry.clientId === c.clientId).length;
    if (inLog !== st.landed)
      violations.push(`client ${i}: ${inLog} in the log, ${st.landed} landed`);
    if (st.unexpectedAccepts > 0)
      violations.push(`client ${i}: ${st.unexpectedAccepts} unexpected accepts`);
    if (
      c.pending.length > 0 ||
      c.confirmedRevision !== server.revision ||
      serialize(c.confirmedDocument) !== head ||
      serialize(c.document) !== head
    ) {
      converged = false;
    }
  }
  return {
    scenario: sc.name,
    seed,
    made,
    landed,
    dropped,
    withdrawn,
    accepted: server.revision,
    remaps,
    restores,
    undos,
    twinRestores,
    converged,
    stuck,
    violations,
  };
}

function label(c: Command): string {
  return c.type === 'addFeature' ? `${c.type} ${c.feature.id}` : c.type;
}
