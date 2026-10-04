import {
  applyCommand,
  createDocument,
  type Command,
  type ExtrudeFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { SyncClient, type SyncClientOptions } from './client';
import type { ClientMessage, ServerMessage } from './protocol';
import { ReferenceServer, type ReferenceServerOptions } from './server';

/**
 * Test-only: a reference server and clients with hand-delivered messages, so a test decides
 * which message arrives when, which is lost and which arrives twice. Not exported.
 */

export const PART = 'part#1';
export const AT = '2026-10-04T12:00:00.000Z';

export function mm(source: string): StoredExpression {
  return { source, lengthUnit: 'mm', angleUnit: 'deg' };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A plate with a hole and a filleted corner: part#1 has sketch#1, extrude#1, sketch#2, extrude#2, fillet#1. */
export function bracket(): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Bracket' });
  const add = (feature: object): Command =>
    ({ type: 'addFeature', partId: PART, feature }) as Command;
  const commands: Command[] = [
    { type: 'setVariable', name: 'thickness', expression: mm('6mm') },
    { type: 'setVariable', name: 'width', expression: mm('40') },
    add(rectangle('sketch#1', ['e1', 'e2', 'e3', 'e4'], ['k1', 'k2'], 0)),
    add(extrudeOf('extrude#1', 'sketch#1', 'Extrude 1')),
    add({
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Sketch 2',
      suppressed: false,
      plane: { type: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
      entities: [{ id: 'e5', kind: 'circle', construction: false, center: [20, 10], radius: 3 }],
      constraints: [{ id: 'k3', kind: 'diameter', entity: 'e5', value: mm('6mm') }],
    }),
    add({
      ...extrudeOf('extrude#2', 'sketch#2', 'Extrude 2'),
      operation: 'cut',
      extent: { type: 'throughAll' },
    }),
  ];
  for (const c of commands) doc = ok(applyCommand(doc, c)).document;
  return doc;
}

export function rectangle(
  id: string,
  e: [string, string, string, string],
  k: [string, string],
  x: number,
): SketchFeature {
  const pts: [number, number][] = [
    [x, 0],
    [x + 40, 0],
    [x + 40, 20],
    [x, 20],
  ];
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: pts.map((p, i) => ({
      id: e[i]!,
      kind: 'line' as const,
      construction: false,
      start: p,
      end: pts[(i + 1) % 4]!,
    })),
    constraints: [
      {
        id: k[0],
        kind: 'coincident',
        a: { entity: e[0], at: 'end' },
        b: { entity: e[1], at: 'start' },
      },
      { id: k[1], kind: 'horizontal', line: e[0] },
    ],
  };
}

export function extrudeOf(id: string, sketch: string, name: string): ExtrudeFeature {
  return {
    id,
    kind: 'extrude',
    name,
    suppressed: false,
    profile: { sketch },
    operation: 'new',
    extent: { type: 'blind', distance: mm('thickness') },
    reverse: false,
  };
}

function part(doc: ManufaktureDocument, partId = PART) {
  const p = doc.parts.find((x) => x.id === partId);
  if (p === undefined) throw new Error(`no ${partId}`);
  return p;
}

function nextId(doc: ManufaktureDocument, counter: string, partId = PART): string {
  const n = part(doc, partId).nextIds[counter] ?? 1;
  return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
}

/** Adds the part's next extrude on `sketch`, named `name`. */
export function addExtrude(
  doc: ManufaktureDocument,
  sketch: string,
  name: string,
  partId = PART,
): Command {
  return {
    type: 'addFeature',
    partId,
    feature: extrudeOf(nextId(doc, 'extrude', partId), sketch, name),
  };
}

/** Adds the part's next sketch, a rectangle at `x`. */
export function addSketch(doc: ManufaktureDocument, x: number, partId = PART): Command {
  const p = part(doc, partId);
  const e = p.nextIds.e ?? 1;
  const k = p.nextIds.k ?? 1;
  return {
    type: 'addFeature',
    partId,
    feature: rectangle(
      nextId(doc, 'sketch', partId),
      [`e${e}`, `e${e + 1}`, `e${e + 2}`, `e${e + 3}`],
      [`k${k}`, `k${k + 1}`],
      x,
    ),
  };
}

/** Renames an extrude through `editFeature` (a whole-feature edit). */
export function editExtrude(
  doc: ManufaktureDocument,
  id: string,
  name: string,
  partId = PART,
): Command {
  const f = part(doc, partId).features.find((x) => x.id === id);
  if (f?.kind !== 'extrude') throw new Error(`no extrude ${id}`);
  return { type: 'editFeature', partId, feature: { ...f, name } };
}

export function feature(doc: ManufaktureDocument, id: string, partId = PART) {
  return part(doc, partId).features.find((x) => x.id === id);
}

export function featureNames(doc: ManufaktureDocument, partId = PART): string[] {
  return part(doc, partId).features.map((f) => `${f.id}=${f.name}`);
}

export type Inbox = ServerMessage[];

/** One server, any number of clients, and per-client inboxes delivered by hand. */
export class Lab {
  readonly server: ReferenceServer;
  readonly clients = new Map<string, SyncClient>();
  readonly inbox = new Map<string, Inbox>();
  /** Every message each client sent, for assertions. */
  readonly sent = new Map<string, ClientMessage[]>();

  constructor(doc: ManufaktureDocument = bracket(), server: ReferenceServerOptions = {}) {
    this.server = new ReferenceServer(doc, server);
  }

  add(id: string, options: Partial<SyncClientOptions> = {}): SyncClient {
    const c = new SyncClient(this.server.head, this.server.revision, {
      clientId: id,
      now: () => AT,
      ...options,
    });
    this.clients.set(id, c);
    this.inbox.set(id, []);
    this.sent.set(id, []);
    return c;
  }

  client(id: string): SyncClient {
    const c = this.clients.get(id);
    if (c === undefined) throw new Error(`no client ${id}`);
    return c;
  }

  /** Replaces a client (after a save and restore). */
  replace(id: string, client: SyncClient): void {
    this.clients.set(id, client);
  }

  /** Hands messages to the server: a client's outgoing ones by default, or the given ones. */
  send(id: string, messages: ClientMessage[] = this.client(id).takeOutgoing()): void {
    this.sent.get(id)!.push(...messages);
    for (const m of messages) this.toServer(id, m);
  }

  /** Takes a client's outgoing messages and loses them. */
  lose(id: string): ClientMessage[] {
    const out = this.client(id).takeOutgoing();
    this.sent.get(id)!.push(...out);
    return out;
  }

  private toServer(id: string, m: ClientMessage): void {
    const handled = this.server.handle(JSON.parse(JSON.stringify(m)));
    this.inbox.get(id)!.push(...handled.replies);
    if (handled.push) for (const box of this.inbox.values()) box.push(handled.push);
  }

  /** Delivers (in order) and removes the messages in a client's inbox that match. */
  deliver(id: string, match: (m: ServerMessage) => boolean = () => true): ServerMessage[] {
    const box = this.inbox.get(id)!;
    const take = box.filter(match);
    this.inbox.set(
      id,
      box.filter((m) => !take.includes(m)),
    );
    for (const m of take) {
      const r = this.client(id).handle(JSON.parse(JSON.stringify(m)));
      if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
    }
    return take;
  }

  /** Removes the matching messages from a client's inbox without delivering them. */
  drop(id: string, match: (m: ServerMessage) => boolean): ServerMessage[] {
    const box = this.inbox.get(id)!;
    const take = box.filter(match);
    this.inbox.set(
      id,
      box.filter((m) => !take.includes(m)),
    );
    return take;
  }

  /** Sends and delivers everything until nothing moves. */
  settle(): void {
    for (let round = 0; round < 100; round++) {
      let moved = false;
      for (const id of this.clients.keys()) {
        const out = this.client(id).takeOutgoing();
        if (out.length > 0) moved = true;
        this.send(id, out);
      }
      for (const id of this.clients.keys()) {
        if (this.inbox.get(id)!.length > 0) moved = true;
        this.deliver(id);
      }
      if (!moved) return;
    }
    throw new Error('the lab did not settle');
  }
}

export const isPush = (m: ServerMessage): boolean => m.type === 'push';
export const verdictOf =
  (clientSeq: number) =>
  (m: ServerMessage): boolean =>
    (m.type === 'ack' || m.type === 'refuse' || m.type === 'predecessor-unknown') &&
    m.clientSeq === clientSeq;
export const isVerdict = (m: ServerMessage): boolean =>
  m.type === 'ack' || m.type === 'refuse' || m.type === 'predecessor-unknown';
