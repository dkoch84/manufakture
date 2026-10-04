// Rebase cost: a client with N unsent commands receives one remote entry and rebases. Two
// cases: the remote entry takes the ids of the first queued command, so every queued command's
// ids move (remap + replay); and a remote entry that allocates nothing (replay only).

import { previewIds, type Command, type ManufaktureDocument } from '@manufakture/core';
import { Client } from './client.ts';
import { Generator } from './generator.ts';
import { Rng } from './rng.ts';

const FEATURE_MIX = {
  replaceDocument: 0,
  addPart: 0,
  duplicatePart: 0,
  addAssembly: 0,
  addInstance: 0,
  addMate: 0,
  configParameter: 0,
  configRow: 0,
  camTool: 0,
  camSetup: 0,
  camOperation: 0,
  delete: 0,
};

export interface BenchRow {
  fixture: string;
  pending: number;
  case: 'collision' | 'no-collision';
  medianMs: number;
  perCommandMs: number;
  remapMs: number;
  replayMs: number;
  renamed: number;
  dropped: number;
  droppedBy: string;
}

/** N commands made one after another on `doc`, as an offline session would. */
function session(doc: ManufaktureDocument, n: number, seed: number): Command[] {
  const gen = new Generator(new Rng(seed), 7, { weights: FEATURE_MIX });
  const out: Command[] = [];
  let d = doc;
  const probe = new Client('probe', doc, { remap: true, rederiveReplace: true }, stub());
  while (out.length < n) {
    const g = gen.generate(d);
    if (!g) throw new Error('bench: the generator gave up');
    out.push(g.command);
    probe.load([g.command]);
    d = probe.visible;
  }
  return out;
}

function stub() {
  return { send: () => {}, now: () => 0, later: () => {} };
}

/** A remote sketch + extrude that takes the next sketch, extrude, e, k ids of part#1. */
function collidingRemote(doc: ManufaktureDocument): Command {
  const p = doc.parts[0]!;
  const [sk] = previewIds(p.nextIds, 'sketch');
  const [ex] = previewIds(p.nextIds, 'extrude');
  const es = previewIds(p.nextIds, 'e', 2);
  return {
    type: 'batch',
    commands: [
      {
        type: 'addFeature',
        partId: p.id,
        feature: {
          id: sk!,
          kind: 'sketch',
          name: 'remote',
          suppressed: false,
          plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
          entities: [
            { id: es[0]!, kind: 'line', construction: false, start: [0, 0], end: [9, 0] },
            { id: es[1]!, kind: 'line', construction: false, start: [9, 0], end: [0, 0.5] },
          ],
          constraints: [],
        },
      },
      {
        type: 'addFeature',
        partId: p.id,
        feature: {
          id: ex!,
          kind: 'extrude',
          name: 'remote extrude',
          suppressed: false,
          profile: { sketch: sk! },
          operation: 'new',
          extent: { type: 'throughAll' },
          reverse: false,
        },
      },
    ],
  };
}

export function bench(
  fixtures: Array<[string, ManufaktureDocument]>,
  sizes: number[],
  runs: number,
): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const [name, doc] of fixtures) {
    for (const n of sizes) {
      const commands = session(doc, n, 1000 + n);
      for (const kind of ['collision', 'no-collision'] as const) {
        const times: number[] = [];
        let last: Client | undefined;
        for (let i = 0; i < runs; i++) {
          const c = new Client('bench', doc, { remap: true, rederiveReplace: true }, stub());
          c.online = false;
          c.load(commands);
          const remote: Command =
            kind === 'collision'
              ? collidingRemote(doc)
              : {
                  type: 'setVariable',
                  name: 'remote',
                  expression: { source: '1', lengthUnit: 'mm', angleUnit: 'deg' },
                };
          const entry = {
            clientId: 'other',
            clientSeq: 1,
            baseRev: 0,
            label: 'remote',
            command: remote,
          };
          const t = performance.now();
          c.receive({ rev: 1, entry });
          times.push(performance.now() - t);
          last = c;
        }
        times.sort((a, b) => a - b);
        const med = times[Math.floor(times.length / 2)]!;
        rows.push({
          fixture: name,
          pending: n,
          case: kind,
          medianMs: round(med),
          perCommandMs: round(med / n, 3),
          remapMs: round(last!.stats.remapMs),
          replayMs: round(last!.stats.replayMs),
          renamed: last!.stats.remap.renamed,
          dropped: last!.stats.dropped,
          droppedBy: JSON.stringify(last!.stats.droppedByType),
        });
      }
    }
  }
  return rows;
}

function round(x: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
