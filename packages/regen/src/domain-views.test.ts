// Domain views (M6 plan T6.4a): what a domain's view returns is checked and bounded before the
// drawing stage uses it, and its model-space parts are projected into view coordinates.

import { viewFrame } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { domainParts } from './drawing';
import {
  MAX_CHAIN_OFFSET,
  MAX_DOMAIN_CHAIN_POINTS,
  MAX_DOMAIN_TITLE_NOTE_LENGTH,
  MAX_DOMAIN_VIEW_CHAINS,
  MAX_DOMAIN_VIEW_LINES,
  checkDomainView,
  type DomainViewOutput,
} from './domain-views';
import { ExtensionRegistry } from './extensions';

const TOP = { direction: [0, 0, -1], up: [0, 1, 0] } as const;

const minimal = (over: Record<string, unknown> = {}) => ({ ...TOP, bodies: [], ...over });

describe('checking a domain view', () => {
  it('accepts a view and copies what it uses', () => {
    const r = checkDomainView(
      minimal({
        section: { origin: [0, 0, 1219.2], normal: [0, 0, 1] },
        bodies: ['extension#1:layer/sheathing'],
        lines: [{ a: [0, 0, 0], b: [10, 0, 0] }],
        arcs: [{ center: [0, 0, 0], normal: [0, 0, 1], from: [1, 0, 0], to: [0, 1, 0] }],
        chains: [
          {
            id: 'w:s1',
            kind: 'aligned',
            points: [
              [0, 0, 0],
              [10, 0, 0],
            ],
            side: [0, -1, 0],
            offset: 10,
          },
        ],
        pitches: [{ id: 'r:pitch', at: [0, 0, 0], pitch: Math.atan(0.5), rises: [1, 0, 0] }],
        titleNote: 'Not an engineering tool.',
        warnings: [{ message: 'one', code: 'x' }],
        extra: 'ignored',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.lines).toEqual([{ a: [0, 0, 0], b: [10, 0, 0], layer: 'visible' }]);
    expect(r.view.titleNote).toBe('Not an engineering tool.');
    expect('extra' in r.view).toBe(false);
  });

  it('passes a domain error through', () => {
    expect(checkDomainView({ error: 'no such wall' })).toEqual({
      ok: false,
      message: 'no such wall',
    });
  });

  it.each([
    ['not an object', 7],
    ['no direction', { up: [0, 1, 0], bodies: [] }],
    ['a zero direction', minimal({ direction: [0, 0, 0] })],
    ['up along the direction', minimal({ up: [0, 0, 2] })],
    ['a number that is not finite', minimal({ lines: [{ a: [0, 0, Infinity], b: [0, 0, 0] }] })],
    ['a coordinate past the member bound', minimal({ lines: [{ a: [2e6, 0, 0], b: [0, 0, 0] }] })],
    ['an unknown layer', minimal({ lines: [{ a: [0, 0, 0], b: [1, 0, 0], layer: 'paint' }] })],
    ['bodies that are not text', minimal({ bodies: [1] })],
    [
      'a chain with no kind',
      minimal({ chains: [{ id: 'c', points: [], side: [0, 1, 0], offset: 1 }] }),
    ],
    [
      'a chain id used twice',
      minimal({
        chains: [
          { id: 'c', kind: 'horizontal', points: [], side: [0, 1, 0], offset: 1 },
          { id: 'c', kind: 'horizontal', points: [], side: [0, 1, 0], offset: 1 },
        ],
      }),
    ],
    [
      'a chain offset off the paper',
      minimal({
        chains: [
          {
            id: 'c',
            kind: 'horizontal',
            points: [],
            side: [0, 1, 0],
            offset: MAX_CHAIN_OFFSET + 1,
          },
        ],
      }),
    ],
    [
      'a pitch of 90 degrees',
      minimal({ pitches: [{ id: 'p', at: [0, 0, 0], pitch: Math.PI / 2, rises: [1, 0, 0] }] }),
    ],
    ['a title note too long', minimal({ titleNote: 'x'.repeat(MAX_DOMAIN_TITLE_NOTE_LENGTH + 1) })],
  ])('refuses %s', (_label, value) => {
    expect(checkDomainView(value).ok).toBe(false);
  });

  it('bounds every list before reading it', () => {
    const line = { a: [0, 0, 0], b: [1, 0, 0] };
    const lines = new Array(MAX_DOMAIN_VIEW_LINES + 1).fill(line);
    const r = checkDomainView(minimal({ lines }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/more than the 400000 allowed/);
    const chain = { id: 'c', kind: 'horizontal', points: [], side: [0, 1, 0], offset: 1 };
    const chains = Array.from({ length: MAX_DOMAIN_VIEW_CHAINS + 1 }, (_, i) => ({
      ...chain,
      id: `c${i}`,
    }));
    expect(checkDomainView(minimal({ chains })).ok).toBe(false);
    const points = new Array(MAX_DOMAIN_CHAIN_POINTS + 1).fill([0, 0, 0]);
    expect(checkDomainView(minimal({ chains: [{ ...chain, points }] })).ok).toBe(false);
  });
});

describe('projecting a domain view', () => {
  const view = (over: Partial<DomainViewOutput>): DomainViewOutput => ({
    direction: [0, 0, -1],
    up: [0, 1, 0],
    bodies: [],
    ...over,
  });

  it('draws an arc seen face on as an arc, an oblique one as a polyline', () => {
    const arc = { center: [0, 0, 0], normal: [0, 0, 1], from: [10, 0, 0], to: [0, 10, 0] } as const;
    const top = domainParts(view({ arcs: [arc] }), viewFrame(TOP), 'view#1');
    const curve = top.overlay[0]!.curve;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.radius).toBe(10);
      expect(curve.end - curve.start).toBeCloseTo(Math.PI / 2, 12);
    }
    const front = domainParts(
      view({ direction: [0, 1, 0], up: [0, 0, 1], arcs: [arc] }),
      viewFrame({ direction: [0, 1, 0], up: [0, 0, 1] }),
      'view#1',
    );
    expect(front.overlay[0]!.curve.kind).toBe('polyline');
    // Seen from below, the same quarter turn still sweeps a quarter turn.
    const below = domainParts(
      view({ arcs: [arc] }),
      viewFrame({ direction: [0, 0, 1], up: [0, 1, 0] }),
      'v',
    );
    const b = below.overlay[0]!.curve;
    expect(b.kind === 'arc' && b.end - b.start).toBeCloseTo(Math.PI / 2, 12);
  });

  it('turns a string side into a signed offset and names it in its view', () => {
    const chain = (side: readonly [number, number, number]) =>
      domainParts(
        view({
          chains: [
            {
              id: 'w:s1',
              kind: 'aligned',
              points: [
                [0, 0, 0],
                [100, 0, 0],
              ],
              side,
              offset: 10,
            },
          ],
        }),
        viewFrame(TOP),
        'view#1',
      ).chains[0]!;
    // Left of the first to last point (+y on the paper) is positive.
    expect(chain([0, 1, 0]).offset).toBe(10);
    expect(chain([0, -1, 0]).offset).toBe(-10);
    expect(chain([0, -1, 0]).id).toBe('view#1/w:s1');
  });

  it('gives a pitch symbol the side its roof rises to, and bounds what it draws', () => {
    const parts = domainParts(
      view({
        lines: [{ a: [-5, -5, 0], b: [20, 30, 0] }],
        pitches: [{ id: 'r', at: [0, 0, 0], pitch: 0.4, rises: [-1, 0, 0] }],
      }),
      viewFrame(TOP),
      'view#1',
    );
    expect(parts.symbols[0]!.rises).toBe('left');
    expect(parts.bounds).toEqual({ min: [-5, -5], max: [20, 30] });
  });
});

describe('registering domain views', () => {
  it('refuses views without a view function or a version', () => {
    const registry = new ExtensionRegistry();
    expect(() =>
      registry.registerDomain({
        namespace: 'construction',
        implementation: 1,
        drawings: { schemaVersion: 0, view: () => ({ error: 'x' }) },
      }),
    ).toThrow(/drawings need/);
    registry.registerDomain({
      namespace: 'construction',
      implementation: 1,
      drawings: { schemaVersion: 1, view: () => ({ error: 'x' }) },
    });
    expect(registry.domainDrawings('construction')?.drawings.schemaVersion).toBe(1);
    expect(registry.domainDrawings('wood')).toBeUndefined();
    expect(() =>
      new ExtensionRegistry().registerDomain({
        namespace: 'construction',
        implementation: 1,
        drawings: {
          schemaVersion: 1,
          titleNote: 'x'.repeat(MAX_DOMAIN_TITLE_NOTE_LENGTH + 1),
          view: () => ({ error: 'x' }),
        },
      }),
    ).toThrow(/title note/);
  });
});
