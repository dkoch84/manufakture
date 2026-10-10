// The parts of a bundle that need no kernel: the feature, script, document and domain diffs, the
// order of regen issues, quantity deltas, the shared camera, and reading a bundle back with its
// bounds checked.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import type { ErrorLine, Quantities as SessionQuantities } from '@manufakture/session';
import { bracketDocument, PART } from '@manufakture/session/test-fixtures';
import { describe, expect, it } from 'vitest';
import { regenIssues } from './bundle';
import { isStale, readBundle } from './data';
import { documentChanges, movedIds, partDiffs, scriptDiffs } from './diff';
import { domainDiffs, summariserMap, type DomainSummariser } from './domains';
import { quantityDeltas } from './quantities';
import { reviewViews, sharedCamera } from './renders';
import { BUNDLE_FORMAT, BUNDLE_VERSION, LIMITS } from './types';

function edit(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

const script = (source: string) => ({
  id: 'script#1',
  name: 'Block',
  language: 'js' as const,
  apiVersion: 1,
  source,
});

describe('feature diff', () => {
  it('finds features added, edited, deleted, renamed, suppressed and reordered', () => {
    const base = bracketDocument();
    const fillet = base.parts[0]!.features.find((f) => f.id === 'fillet#1')!;
    const head = edit(
      base,
      { type: 'reorderFeature', partId: PART, featureId: 'hole#1', index: 4 },
      { type: 'suppressFeature', partId: PART, featureId: 'fillet#1', suppressed: true },
      { type: 'renameFeature', partId: PART, featureId: 'sketch#2', name: 'Holes' },
      {
        type: 'editFeature',
        partId: PART,
        feature: {
          ...fillet,
          suppressed: true,
          radius: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' },
        } as never,
      },
      { type: 'deleteFeature', partId: PART, featureId: 'hole#1' },
    );
    const [part] = partDiffs(base, head);
    expect(part!.items.items.map((i) => [i.id, i.changes])).toEqual([
      ['sketch#2', ['renamed']],
      ['fillet#1', ['suppressed', 'edited']],
      ['hole#1', ['deleted']],
    ]);
    expect(part!.items.items[1]!.summary).toBe(
      'Suppressed Fillet 1; Edited Fillet 1: radius 4 mm to 3 mm',
    );
    const moved = partDiffs(
      base,
      edit(base, { type: 'reorderFeature', partId: PART, featureId: 'hole#1', index: 4 }),
    )[0]!.items.items;
    expect(moved).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/hole#1|fillet#1/),
        changes: ['reordered'],
      }),
    ]);
    expect(partDiffs(base, base)).toEqual([]);
  });

  it('marks as moved only what left the common order', () => {
    expect([...movedIds(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'b'])]).toEqual(['b']);
    expect([...movedIds(['a', 'b'], ['a', 'b', 'x'])]).toEqual([]);
  });

  it('lists other document changes as fields', () => {
    const base = bracketDocument();
    const head = edit(base, {
      type: 'setVariable',
      name: 'thickness',
      expression: { source: '8', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    expect(documentChanges(base, head)).toEqual([
      { path: 'variables.thickness', before: '6 mm', after: '8 mm' },
    ]);
  });
});

describe('scripts', () => {
  const scripted = {
    type: 'addFeature',
    partId: PART,
    feature: {
      id: 'scripted#1',
      kind: 'scripted',
      name: 'Block',
      suppressed: false,
      script: 'script#1',
      params: {},
      seed: 0,
      dependsOn: [],
    },
  } as Command;

  it('shows a changed script with its old source, and flags hidden characters', () => {
    const base = edit(bracketDocument(), { type: 'setScript', script: script('let a = 1;\n') });
    const head = edit(base, { type: 'setScript', script: script('let a = 2; // ‮evil\n') });
    expect(scriptDiffs(base, head)).toEqual([
      expect.objectContaining({
        change: 'changed',
        source: 'let a = 2; // ‮evil\n',
        previous: 'let a = 1;\n',
        hiddenCharacters: true,
        truncated: false,
      }),
    ]);
  });

  it('shows an unchanged script that a new scripted feature runs, and a deleted one', () => {
    const base = edit(bracketDocument(), { type: 'setScript', script: script('// block\n') });
    const head = edit(base, scripted);
    expect(scriptDiffs(base, head)).toEqual([
      expect.objectContaining({
        change: 'used',
        source: '// block\n',
        features: [`${PART}/scripted#1`],
      }),
    ]);
    expect(scriptDiffs(base, bracketDocument())).toEqual([
      expect.objectContaining({ change: 'deleted', source: '// block\n' }),
    ]);
  });
});

describe('domain data', () => {
  it("uses the namespace's summariser, else the changed fields; a throwing one falls back", () => {
    const base = bracketDocument();
    const head = edit(
      base,
      { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { grain: 'ignore' } },
      { type: 'setDomainData', namespace: 'acme', schemaVersion: 1, data: { level: 3 } },
    );
    expect(domainDiffs(base, head, summariserMap())).toEqual([
      {
        namespace: 'acme',
        change: 'added',
        lines: ['schema version none to 1', 'level: none to 3'],
        omitted: 0,
      },
      { namespace: 'wood', change: 'added', lines: ['Grain: not set to ignore'], omitted: 0 },
    ]);
    const throwing: DomainSummariser = {
      namespace: 'wood',
      summarise: () => {
        throw new Error('no');
      },
    };
    expect(domainDiffs(base, head, summariserMap([throwing]))[1]!.lines).toEqual([
      'schema version none to 1',
      'grain: none to "ignore"',
    ]);
  });
});

describe('mechanical diff', () => {
  const se = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
  const loadCase = {
    id: 'lc#1',
    name: 'Max set',
    static: [
      {
        kind: 'acceleration' as const,
        name: 'Drop',
        acceleration: se('5 gn'),
        direction: [0, 0, -1] as const,
      },
    ],
  };

  it("joins the settings' lines and the section's under the mech namespace, with the notice", () => {
    const base = bracketDocument();
    const head = edit(
      base,
      {
        type: 'setDomainData',
        namespace: 'mech',
        schemaVersion: 1,
        data: { factors: { strength: 2 } },
      },
      { type: 'setMechLoadCase', loadCase },
    );
    const [mech] = domainDiffs(base, head, summariserMap());
    expect(mech!.namespace).toBe('mech');
    expect(mech!.change).toBe('added');
    expect(mech!.lines.slice(0, 4)).toEqual([
      'Started the mechanical domain',
      'Strength factor (on yield): 2',
      'Fatigue factor: not set',
      'Added load case "Max set" (lc#1)',
    ]);
    expect(mech!.lines.at(-1)).toMatch(/^manufakture calculates by the methods/);
    // A section change alone is reported too, and a change back to nothing is "removed".
    const renamed = edit(head, {
      type: 'setMechLoadCase',
      loadCase: { ...loadCase, name: 'Heavy' },
    });
    expect(domainDiffs(head, renamed, summariserMap())[0]!.lines[0]).toBe(
      'Changed load case "Heavy" (lc#1): name',
    );
    for (const line of mech!.lines.slice(0, -1)) {
      expect(line).not.toMatch(/\b(safe|certified|compliant|pass|fail|ok)\b/i);
    }
  });

  it('lists user materials among the document changes', () => {
    const base = bracketDocument();
    const head = edit(base, {
      type: 'setMaterialDef',
      material: {
        id: 'material#1',
        name: 'My PETG',
        category: 'plastic',
        form: 'printed',
        density: { value: se('1270 kg/m^3'), source: 'label', typical: true },
      },
    });
    expect(documentChanges(base, head).map((c) => c.path)).toContain('materials.material#1');
  });
});

describe('regen issues', () => {
  const line = (featureId: string, severity: 'error' | 'warning', code = 'x'): ErrorLine => ({
    where: 'feature',
    partId: PART,
    featureId,
    severity,
    code,
    message: `${featureId} ${code}`,
  });

  it('puts new ones first, errors before warnings, and keeps what was fixed', () => {
    const issues = regenIssues(
      [line('a', 'error'), line('b', 'warning')],
      [line('a', 'error'), line('c', 'warning'), line('d', 'error')],
    );
    expect(issues.new.items.map((i) => i.featureId)).toEqual(['d', 'c']);
    expect(issues.remaining.items.map((i) => i.featureId)).toEqual(['a']);
    expect(issues.resolved.items.map((i) => i.featureId)).toEqual(['b']);
    expect(issues.counts).toEqual({
      base: { errors: 1, warnings: 1 },
      head: { errors: 2, warnings: 1 },
    });
  });
});

describe('quantities', () => {
  const q = (rows: { key: string; quantity: number }[]): SessionQuantities =>
    ({
      reviewed: false,
      cutList: {
        rows: rows.map((r) => ({
          ...r,
          item: r.key,
          category: 'sheet',
          unit: 'each',
          extended: r.quantity,
        })),
        hardware: [],
        totals: [
          {
            group: 'sheet',
            unit: 'each',
            value: rows.reduce((n, r) => n + r.quantity, 0),
            quantity: 0,
          },
        ],
      },
      hardware: [],
      takeoffs: [],
      notes: [],
    }) as unknown as SessionQuantities;

  it('lists only rows and totals that differ', () => {
    const d = quantityDeltas(
      q([
        { key: 'a', quantity: 1 },
        { key: 'b', quantity: 2 },
      ]),
      q([
        { key: 'a', quantity: 1 },
        { key: 'c', quantity: 4 },
      ]),
      (id) => id,
    );
    expect(
      d.rows.items.map((r) => [r.key, r.base?.quantity ?? null, r.head?.quantity ?? null]),
    ).toEqual([
      ['c', null, 4],
      ['b', 2, null],
    ]);
    expect(d.totals).toEqual([
      { list: 'cut list', group: 'sheet', unit: 'each', base: 3, head: 5 },
    ]);
    expect(d).not.toHaveProperty('phases');
  });

  it("adds the head's new material and demolition list, whole, when it has phases (#1213)", () => {
    const takeoff = (n: number) =>
      ({
        reviewed: false,
        cutList: null,
        hardware: [],
        takeoffs: [
          {
            partId: 'part#1',
            notes: [],
            takeoff: {
              rows: [
                {
                  key: 'framing|stud',
                  item: 'Stud',
                  category: 'framing',
                  unit: 'each',
                  quantity: n,
                  extended: n,
                  sources: [{ id: 'x' }],
                },
              ],
              totals: [{ group: 'framing', unit: 'each', value: n }],
            },
          },
        ],
        notes: ['a phase note'],
      }) as unknown as SessionQuantities;
    const same = q([{ key: 'a', quantity: 1 }]);
    const d = quantityDeltas(same, same, () => 'Part 1', { new: takeoff(3), demolish: takeoff(2) });
    expect(d.rows.items).toEqual([]);
    expect(d.phases).toEqual({
      newMaterial: [
        {
          list: 'takeoff Part 1',
          rows: {
            items: [
              {
                key: 'framing|stud',
                item: 'Stud',
                category: 'framing',
                unit: 'each',
                quantity: 3,
                extended: 3,
              },
            ],
            omitted: 0,
          },
          totals: [{ group: 'framing', unit: 'each', value: 3 }],
        },
      ],
      demolition: [
        expect.objectContaining({ totals: [{ group: 'framing', unit: 'each', value: 2 }] }),
      ],
    });
    expect(d.notes).toContain('a phase note');
  });
});

describe('views', () => {
  it('frames both sides alike, and keeps a camera that frames itself', () => {
    const box = {
      min: [0, 0, 0] as [number, number, number],
      max: [100, 50, 20] as [number, number, number],
    };
    expect(
      sharedCamera({ name: 'front', camera: 'front' }, box, { width: 400, height: 300 }),
    ).toEqual({
      position: [50, 24, 10],
      target: [50, 25, 10],
      up: [0, 0, 1],
      extent: round3((100 / (400 - 48)) * 300),
    });
    const fixed = { view: 'top' as const, extent: 10 };
    expect(sharedCamera({ name: 'mine', camera: fixed }, box, { width: 400, height: 300 })).toBe(
      fixed,
    );
    expect(() => reviewViews(Array.from({ length: 5 }, (_, i) => ({ name: `v${i}` })))).toThrow();
    expect(reviewViews([{ name: 'detail' }]).map((v) => v.name)).toEqual([
      'isometric',
      'front',
      'top',
      'right',
      'detail',
    ]);
  });
});

function round3(v: number): number {
  return Number(v.toPrecision(12));
}

describe('reading a bundle back', () => {
  const minimal = () => ({
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    key: { documentId: 'd', branch: 'b', baseVersion: 'v', headRevision: 3 },
    renders: [{ name: 'iso', base: { sha256: 'a'.repeat(64) }, head: null }],
  });

  it('accepts a well-formed one and refuses one past its bounds', () => {
    expect(readBundle(minimal()).ok).toBe(true);
    expect(readBundle({ ...minimal(), format: 'other' }).ok).toBe(false);
    expect(readBundle({ ...minimal(), key: { ...minimal().key, headRevision: 0 } }).ok).toBe(false);
    expect(readBundle({ ...minimal(), documentName: 'x'.repeat(LIMITS.text + 1) }).ok).toBe(false);
    expect(
      readBundle({ ...minimal(), renders: [{ name: 'iso', base: { sha256: '../../etc' } }] }).ok,
    ).toBe(false);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(readBundle({ ...minimal(), deep }).ok).toBe(false);
    expect(readBundle({ ...minimal(), list: new Array(100_000).fill(0) }).ok).toBe(false);
    expect(readBundle({ ...minimal(), n: Number.NaN }).ok).toBe(false);
    // A script may be long, a name may not.
    expect(readBundle({ ...minimal(), scripts: [{ source: 'x'.repeat(10_000) }] }).ok).toBe(true);
  });

  it('is stale when the branch, its head revision or its base moved', () => {
    const b = minimal();
    expect(isStale(b, { branch: 'b', revision: 3 })).toBe(false);
    expect(isStale(b, { branch: 'b', revision: 3, baseVersion: 'v' })).toBe(false);
    expect(isStale(b, { branch: 'b', revision: 4 })).toBe(true);
    expect(isStale(b, { branch: 'c', revision: 3 })).toBe(true);
    expect(isStale(b, { branch: 'b', revision: 3, baseVersion: 'w' })).toBe(true);
  });
});
