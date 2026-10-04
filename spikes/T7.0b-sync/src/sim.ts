// The concurrent run: clients, the server and a network with random latency (so random delivery
// orders), optional loss of submits and verdicts, and optional offline stretches, on a virtual
// clock driven by a seeded event queue.

import { serialize, type ManufaktureDocument } from '@manufakture/core';
import { Client } from './client.ts';
import { Generator, type GenOptions } from './generator.ts';
import { checkIntent } from './intent.ts';
import type { Broadcast, SyncEntry, Verdict } from './protocol.ts';
import { Rng } from './rng.ts';
import { Server } from './server.ts';

export interface Scenario {
  name: string;
  clients: number;
  commandsPerClient: number;
  /** Mean time between one client's commands. */
  think: number;
  /** Mean one-way latency; each message gets its own random delay. */
  latency: number;
  /** Probability that a submit or a verdict is lost (broadcasts are not). */
  loss: number;
  /** Deliver each client's submits in the order sent (one ordered channel), not independently. */
  fifo?: boolean;
  /** Client 0 is offline in [from, to) of the virtual clock. */
  offline?: { from: number; to: number };
  generator?: GenOptions;
  remap: boolean;
  rederiveReplace: boolean;
  guardCounters: boolean;
  guardCreated: boolean;
  /** An ablation (a safeguard switched off): left out of the aggregate tables. */
  ablation?: boolean;
}

export interface RunResult {
  scenario: string;
  seed: number;
  generated: number;
  accepted: number;
  dropped: number;
  droppedBy: Record<string, number>;
  droppedByType: Record<string, number>;
  remappedEntries: number;
  refusals: Record<string, number>;
  resubmits: number;
  renamed: number;
  orderFlips: number;
  unresolved: number;
  byScope: Record<string, number>;
  byCategory: Record<string, { generated: number; accepted: number; dropped: number }>;
  remapMisses: number;
  missLog: string[];
  certainAccepted: number;
  orderViolations: number;
  createdCaught: number;
  takeovers: number;
  converged: boolean;
  violations: string[];
  intentChecked: number;
  misbound: string[];
  lost: number;
  revisions: number;
  features: number;
  stuck: boolean;
  wallMs: number;
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
  get size(): number {
    return this.heap.length;
  }
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

const MAX_EVENTS = 3_000_000;

export function runScenario(
  sc: Scenario,
  seed: number,
  start: ManufaktureDocument,
  inspect?: (server: Server, clients: Client[]) => void,
): RunResult {
  const t0 = performance.now();
  const rng = new Rng(seed);
  const events = new Events();
  let now = 0;
  const server = new Server(start, {
    guardCounters: sc.guardCounters,
    guardCreated: sc.guardCreated,
  });
  const clients: Client[] = [];
  const gens: Generator[] = [];
  const remaining: number[] = [];
  const inbox: Array<Array<() => void>> = [];
  const lastSubmit: number[] = [];
  const isOffline = (i: number) =>
    i === 0 && sc.offline !== undefined && now >= sc.offline.from && now < sc.offline.to;
  const latency = () => rng.exp(sc.latency);

  /** Deliver to client i, or keep it until the client is back online. */
  const deliver = (i: number, fn: () => void) => {
    events.push(now + latency(), () => (isOffline(i) ? inbox[i]!.push(fn) : fn()));
  };

  const submit = (i: number, entry: SyncEntry) => {
    if (isOffline(i)) return; // never reaches the network; resubmitted once back online
    let at = now + latency();
    if (sc.fifo) at = lastSubmit[i] = Math.max(at, lastSubmit[i] ?? 0);
    events.push(at, () => {
      if (rng.chance(sc.loss)) return;
      const { verdict, broadcast } = server.submit(entry);
      if (!rng.chance(sc.loss)) deliver(i, () => clients[i]!.verdict(verdict as Verdict));
      if (broadcast) {
        for (let j = 0; j < clients.length; j++) {
          const b: Broadcast = broadcast;
          deliver(j, () => clients[j]!.receive(b));
        }
      }
    });
  };

  for (let i = 0; i < sc.clients; i++) {
    const gen = new Generator(new Rng(seed * 101 + i + 1), i + 1, sc.generator);
    const client = new Client(
      `client-${i + 1}`,
      start,
      { remap: sc.remap, rederiveReplace: sc.rederiveReplace },
      {
        send: (e) => submit(i, e),
        now: () => now,
        later: (fn) => events.push(now + 2 * sc.latency, fn),
      },
    );
    client.onConfirmed = (d) => {
      gen.history.push(d);
      if (gen.history.length > 30) gen.history.splice(0, gen.history.length - 30);
    };
    gen.history.push(start);
    clients.push(client);
    gens.push(gen);
    remaining.push(sc.commandsPerClient);
    inbox.push([]);
  }

  const timeout = sc.latency * 8;
  const act = (i: number) => {
    const c = clients[i]!;
    if (c.online !== !isOffline(i)) {
      if (!isOffline(i)) {
        // Back online: take what arrived meanwhile first (the pull), then send.
        const held = inbox[i]!.splice(0);
        c.online = true;
        for (const fn of held) fn();
        c.setOnline(true);
      } else {
        c.setOnline(false);
      }
    }
    if (remaining[i]! > 0) {
      const g = gens[i]!.generate(c.visible);
      if (g) c.execute(g.command, g.label, g.restoreOf);
      remaining[i]!--;
    }
    if (remaining[i]! > 0 || c.pending() > 0 || inbox[i]!.length > 0) {
      events.push(now + rng.exp(sc.think), () => act(i));
    }
  };
  const tick = (i: number) => {
    clients[i]!.resubmitAll(timeout);
    if (remaining[i]! > 0 || clients[i]!.pending() > 0 || inbox[i]!.length > 0) {
      events.push(now + timeout, () => tick(i));
    }
  };
  for (let i = 0; i < sc.clients; i++) {
    events.push(rng.exp(sc.think), () => act(i));
    events.push(timeout, () => tick(i));
  }

  let count = 0;
  let stuck = false;
  for (let e = events.pop(); e; e = events.pop()) {
    now = e.at;
    e.run();
    if (++count > MAX_EVENTS) {
      stuck = true;
      break;
    }
  }

  inspect?.(server, clients);
  const head = serialize(server.doc);
  const converged =
    !stuck &&
    clients.every(
      (c) =>
        c.pending() === 0 &&
        c.confirmedRev === server.rev &&
        serialize(c.confirmed) === head &&
        serialize(c.visible) === head,
    );
  const sum = (f: (c: Client) => number) => clients.reduce((s, c) => s + f(c), 0);
  const droppedBy: Record<string, number> = {};
  for (const c of clients) {
    for (const [k, v] of Object.entries(c.stats.droppedBy)) droppedBy[k] = (droppedBy[k] ?? 0) + v;
  }
  const intent = checkIntent(server.doc);
  return {
    scenario: sc.name,
    seed,
    generated: sum((c) => c.stats.generated),
    accepted: server.rev,
    dropped: sum((c) => c.stats.dropped),
    droppedBy,
    droppedByType: merge(clients.map((c) => c.stats.droppedByType)),
    remappedEntries: sum((c) => c.stats.remappedEntries),
    refusals: Object.fromEntries(server.refusals),
    resubmits: sum((c) => c.stats.resubmits),
    renamed: sum((c) => c.stats.remap.renamed),
    orderFlips: sum((c) => c.stats.remap.orderFlips),
    unresolved: sum((c) => c.stats.remap.unresolved),
    byScope: merge(clients.map((c) => c.stats.remap.byScope)),
    byCategory: mergeCategories(clients.map((c) => c.stats.byCategory)),
    remapMisses: sum((c) => c.stats.remapMisses),
    missLog: clients.flatMap((c) => c.stats.missLog),
    certainAccepted: sum((c) => c.stats.certainAccepted),
    createdCaught: server.createdCaught,
    takeovers: server.takeovers,
    orderViolations: sum((c) => c.stats.orderViolations),
    converged,
    violations: server.violations,
    intentChecked: intent.checked,
    misbound: intent.misbound,
    lost: intent.lost,
    revisions: server.rev,
    features: server.doc.parts.reduce((s, p) => s + p.features.length, 0),
    stuck,
    wallMs: performance.now() - t0,
  };
}

function merge(xs: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function mergeCategories(
  xs: Array<Record<string, { generated: number; accepted: number; dropped: number }>>,
): Record<string, { generated: number; accepted: number; dropped: number }> {
  const out: Record<string, { generated: number; accepted: number; dropped: number }> = {};
  for (const x of xs) {
    for (const [k, v] of Object.entries(x)) {
      const o = (out[k] ??= { generated: 0, accepted: 0, dropped: 0 });
      o.generated += v.generated;
      o.accepted += v.accepted;
      o.dropped += v.dropped;
    }
  }
  return out;
}
