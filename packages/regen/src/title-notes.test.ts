import type { ManufaktureDocument, ViewSource } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { shownNamespaces } from './title-notes';

const ext = (id: string, extension: string) => ({ id, kind: 'extension', extension });
const part = (id: string, features: unknown[]) => ({ id, features });
/** A pinned source carrying `doc` as its JSON text. */
const pin = (doc: unknown, partId: string, sha: string) => ({
  documentId: 'other',
  partId,
  sha256: sha,
  data: JSON.stringify(doc),
});
const doc = (over: Record<string, unknown>) =>
  ({ parts: [], assemblies: [], ...over }) as never as ManufaktureDocument;

describe('the domains a sheet shows', () => {
  const shed = part('part#1', [
    ext('extension#1', 'construction.wall'),
    { id: 'extrude#1', kind: 'extrude' },
  ]);
  const box = part('part#2', [{ id: 'extrude#1', kind: 'extrude' }]);

  it("a part view: its extension features' namespaces; a domain view: its own too", () => {
    const d = doc({ parts: [shed, box] });
    expect(shownNamespaces(d, [{ part: 'part#1' }])).toEqual(['construction']);
    expect(shownNamespaces(d, [{ part: 'part#2' }])).toEqual([]);
    const failed: ViewSource = {
      domain: 'construction',
      part: 'part#2',
      schemaVersion: 1,
      params: {},
    };
    expect(shownNamespaces(d, [failed])).toEqual(['construction']);
  });

  it("an assembly view: its instances' parts, a pinned instance's too", () => {
    const other = { parts: [part('p', [ext('extension#4', 'wood.board')])] };
    const d = doc({
      parts: [shed, box],
      assemblies: [
        {
          id: 'assembly#1',
          instances: [{ source: { part: 'part#2' } }, { source: { part: 'part#1' } }],
        },
        { id: 'assembly#2', instances: [{ source: pin(other, 'p', 'a'.repeat(64)) }] },
      ],
    });
    expect(shownNamespaces(d, [{ assembly: 'assembly#1' }])).toEqual(['construction']);
    expect(shownNamespaces(d, [{ assembly: 'assembly#2' }])).toEqual(['wood']);
    expect(shownNamespaces(d, [{ assembly: 'assembly#9' }])).toEqual([]);
  });

  it('follows derived features through pins, at most the derived depth, and skips bad text', () => {
    // A chain of pins, each part deriving the next; the last has a construction wall.
    let inner: unknown = { parts: [shed] };
    let partId = 'part#1';
    for (let i = 0; i < 3; i++) {
      inner = {
        parts: [
          part(`d${i}`, [
            { id: 'derived#1', kind: 'derived', source: pin(inner, partId, `${i}`.repeat(64)) },
          ]),
        ],
      };
      partId = `d${i}`;
    }
    const d = doc({
      parts: [
        part('part#3', [
          { id: 'derived#1', kind: 'derived', source: pin(inner, partId, 'f'.repeat(64)) },
        ]),
      ],
    });
    expect(shownNamespaces(d, [{ part: 'part#3' }])).toEqual(['construction']);
    expect(shownNamespaces(d, [{ part: 'part#3' }], 3)).toEqual([]);
    const bad = doc({
      parts: [
        part('part#4', [
          { id: 'derived#1', kind: 'derived', source: { sha256: 'b', partId: 'x', data: '{' } },
        ]),
      ],
    });
    expect(shownNamespaces(bad, [{ part: 'part#4' }])).toEqual([]);
  });

  it('reads each assembly once, however many views show it', () => {
    let reads = 0;
    const instances = Array.from({ length: 1_000 }, () => ({ source: { part: 'part#1' } }));
    const big = { id: 'assembly#1' } as Record<string, unknown>;
    Object.defineProperty(big, 'instances', {
      enumerable: true,
      get: () => {
        reads++;
        return instances;
      },
    });
    const others = Array.from({ length: 1_000 }, (_, i) => ({
      id: `assembly#${i + 2}`,
      instances: [],
    }));
    const d = doc({ parts: [shed], assemblies: [...others, big] });
    const views: ViewSource[] = Array.from({ length: 1_000 }, () => ({ assembly: 'assembly#1' }));
    expect(shownNamespaces(d, views)).toEqual(['construction']);
    expect(reads).toBe(1);
  });

  it('reaches a part at its least depth, whatever path is queued first', () => {
    // S.P derives Q (a construction part). The root reaches S.P directly (depth 1) and through a
    // two-pin chain (depth 3); with a depth cap of 3, Q is in reach only through the short path.
    const q = { parts: [shed] };
    const s = {
      parts: [
        part('P', [{ id: 'derived#1', kind: 'derived', source: pin(q, 'part#1', 'q'.repeat(64)) }]),
      ],
    };
    const sPin = pin(s, 'P', 's'.repeat(64));
    const l2 = { parts: [part('L2', [{ id: 'derived#1', kind: 'derived', source: sPin }])] };
    const l1 = {
      parts: [
        part('L1', [{ id: 'derived#1', kind: 'derived', source: pin(l2, 'L2', '2'.repeat(64)) }]),
      ],
    };
    for (const order of [0, 1]) {
      const long = { id: 'derived#1', kind: 'derived', source: pin(l1, 'L1', '1'.repeat(64)) };
      const short = { id: 'derived#2', kind: 'derived', source: sPin };
      const d = doc({ parts: [part('part#9', order === 0 ? [long, short] : [short, long])] });
      expect(shownNamespaces(d, [{ part: 'part#9' }], 3), `order ${order}`).toEqual([
        'construction',
      ]);
    }
  });

  it("queues every view's own parts before an earlier assembly view's pinned instances", () => {
    // T.Y derives a construction part. Assembly A pins S.P, which derives T.Y (depth 2); part R,
    // shown by a later view, derives T.Y directly (depth 1). With a depth cap of 2, the
    // construction part is in reach only when T.Y is reached through R.
    const q = { parts: [shed] };
    const t = {
      parts: [
        part('Y', [{ id: 'derived#1', kind: 'derived', source: pin(q, 'part#1', 'q'.repeat(64)) }]),
      ],
    };
    const tPin = pin(t, 'Y', 't'.repeat(64));
    const sDoc = { parts: [part('P', [{ id: 'derived#1', kind: 'derived', source: tPin }])] };
    const d = doc({
      parts: [part('R', [{ id: 'derived#1', kind: 'derived', source: tPin }])],
      assemblies: [{ id: 'A', instances: [{ source: pin(sDoc, 'P', 's'.repeat(64)) }] }],
    });
    expect(shownNamespaces(d, [{ assembly: 'A' }, { part: 'R' }], 2)).toEqual(['construction']);
  });
});
