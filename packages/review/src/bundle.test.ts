// Bundles for scripted edits of the three M8 fixtures (the bracket, the cabinet, the shed), built
// through a real session's `submit` on the kernel in this thread and compared with JSON goldens
// in test/goldens: structure, names and text exactly, numbers to a relative 1e-6, and the
// bracket's and cabinet's images by their SHA-256. The shed's member meshes go through JS Math,
// which differs by an ULP or two between V8 versions (docs/spikes/T8.0a-headless.md), so its
// images are checked as PNGs of the right size against the golden, and byte for byte only
// within one run (the worker engine's bundle against the in-process one). Then: the PNGs are
// blobs of the document; a later write makes the bundle stale; a scripted feature shows its
// script in full.
// After a deliberate change to the bundle, to the renderer or to regen, rewrite the goldens and
// read the diff:
//
//   UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run --project packages packages/review

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { MAIN_BRANCH } from '@manufakture/library';
import { BackendBundleStore, startEngine, type Session } from '@manufakture/session';
import {
  PART,
  bracketDocument,
  cabinetDocument,
  shedDocument,
} from '@manufakture/session/test-fixtures';
import { ok, seeded, type Seeded } from '@manufakture/session/test-setup';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBundle, bundleBuilder } from './bundle';
import { isStale, readBundle } from './data';
import type { ReviewBundle } from './types';

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), 'test', 'goldens');
const UPDATE = process.env.UPDATE_GOLDENS === '1';
/** Small images keep the test quick; the views are the same at any size. */
const SIZE = { width: 320, height: 240 } as const;

const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });
const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });

const open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function start(
  doc: ManufaktureDocument,
  engine: 'in-process' | 'worker' = 'in-process',
): Promise<{ seed: Seeded; s: Session }> {
  const seed = await seeded(doc, { engine });
  const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Test' }));
  open.push(s);
  return { seed, s };
}

/** The bundle with the ids a run makes up (branch, base version) replaced, for the golden. */
function normalised(bundle: ReviewBundle): ReviewBundle {
  const { branch, baseVersion } = bundle.key;
  const text = JSON.stringify(bundle)
    .split(branch)
    .join('<branch>')
    .split(baseVersion)
    .join('<base-version>');
  return JSON.parse(text) as ReviewBundle;
}

/** Relative tolerance for numbers against a golden: far above ULP drift, far below a reading. */
const TOLERANCE = 1e-6;

/**
 * Where `actual` differs from `expected`: keys, array lengths, strings and booleans exactly,
 * numbers to TOLERANCE. `images: 'shape'` leaves out each render's sha256 and byte count (the
 * width and height still count).
 */
function differences(
  actual: unknown,
  expected: unknown,
  images: 'exact' | 'shape',
  path = '',
  out: string[] = [],
): string[] {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const scale = Math.max(Math.abs(actual), Math.abs(expected), 1e-9);
    if (Math.abs(actual - expected) > TOLERANCE * scale)
      out.push(`${path}: ${actual} != ${expected}`);
    return out;
  }
  if (
    typeof actual !== 'object' ||
    actual === null ||
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    if (actual !== expected)
      out.push(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    return out;
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
  if (Array.isArray(actual) && a.length !== e.length) {
    out.push(`${path}: ${String(a.length)} items != ${String(e.length)}`);
    return out;
  }
  const imageRef = images === 'shape' && /^renders\[\d+\]\.(base|head)$/.test(path);
  for (const k of keys) {
    if (imageRef && (k === 'sha256' || k === 'bytes')) continue;
    const p = Array.isArray(actual) ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`;
    if (!(k in a) || !(k in e)) out.push(`${p}: ${k in a ? 'not in the golden' : 'missing'}`);
    else differences(a[k], e[k], images, p, out);
  }
  return out;
}

function golden(name: string, bundle: ReviewBundle, images: 'exact' | 'shape' = 'exact'): void {
  const path = join(GOLDENS, `${name}.json`);
  const text = `${JSON.stringify(normalised(bundle), null, 2)}\n`;
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(path, text);
    if (!UPDATE) throw new Error(`${name}.json was missing and has been written: check it, rerun`);
  }
  const found = differences(JSON.parse(text), JSON.parse(readFileSync(path, 'utf8')), images);
  expect(found, `${name}.json`).toEqual([]);
}

/** Submit with the real builder and read the stored bundle back. */
async function submitted(seed: Seeded, s: Session, note: string): Promise<ReviewBundle> {
  ok(await s.submit(bundleBuilder({ imageSize: SIZE }), note));
  const stored = await new BackendBundleStore(seed.backend).latest(seed.documentId, s.branch);
  expect(stored).not.toBeNull();
  const read = readBundle(stored!.bundle);
  if (!read.ok) throw new Error(read.message);
  return read.bundle;
}

/** Every image a bundle names is a stored blob, a PNG, of the size it says. */
async function expectImages(seed: Seeded, bundle: ReviewBundle): Promise<void> {
  const store = new BackendBundleStore(seed.backend);
  let count = 0;
  for (const view of bundle.renders) {
    for (const ref of [view.base, view.head]) {
      if (ref === null) continue;
      const png = await store.readBlob(seed.documentId, ref.sha256);
      expect(png, `${view.name} ${ref.sha256}`).not.toBeNull();
      expect(png!.length).toBe(ref.bytes);
      expect([...png!.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = new DataView(png!.buffer, png!.byteOffset + 16, 8);
      expect([ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual([ref.width, ref.height]);
      expect([ref.width, ref.height]).toEqual([SIZE.width, SIZE.height]);
      count++;
    }
  }
  expect(count).toBeGreaterThanOrEqual(8);
}

const feature = (s: Session, id: string) => s.document.parts[0]!.features.find((f) => f.id === id)!;

describe('the bracket', () => {
  it('a boss, a smaller fillet, a material and an assembly of two; Main deleted the fillet', async () => {
    const { seed, s } = await start(bracketDocument());
    ok(
      await s.apply({
        label: 'Add a boss',
        commands: [
          {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'sketch#$s',
              kind: 'sketch',
              name: 'Boss sketch',
              suppressed: false,
              plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
              entities: [
                { id: 'e$c', kind: 'circle', construction: false, center: [3, 0], radius: 2 },
              ],
              constraints: [],
            },
          },
          {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'extrude#$boss',
              kind: 'extrude',
              name: 'Boss',
              suppressed: false,
              profile: { sketch: 'sketch#$s' },
              operation: 'add',
              extent: { type: 'blind', distance: mm(5) },
              reverse: false,
            },
          },
        ],
      }),
    );
    const fillet = feature(s, 'fillet#1');
    ok(
      await s.apply({
        label: 'Smaller fillet',
        commands: [{ type: 'editFeature', partId: PART, feature: { ...fillet, radius: mm(2) } }],
      }),
    );
    ok(
      await s.apply({
        label: 'Aluminium',
        commands: [{ type: 'setMaterial', partId: PART, material: 'aluminium-6061' }],
      }),
    );
    const instance = (id: string, x: number) => ({
      type: 'addInstance',
      assemblyId: 'assembly#$a',
      instance: {
        id,
        name: id === 'inst#$one' ? 'Left' : 'Right',
        source: { part: PART },
        fixed: true,
        suppressed: false,
        pose: { translation: [x, 0, 0], rotation: [0, 0, 0, 1] },
      },
    });
    ok(
      await s.apply({
        label: 'Two brackets',
        commands: [
          { type: 'addAssembly', assemblyId: 'assembly#$a', name: 'Pair' },
          instance('inst#$one', 0),
          instance('inst#$two', 10),
        ],
      }),
    );
    // A person deletes the fillet on Main meanwhile: the agent's fillet edit would not apply.
    const main = ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).document;
    const del: Command = { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' };
    const next = applyCommand(main, del);
    if (!next.ok) throw new Error(next.error.message);
    await seed.library.save(
      next.value.document,
      [{ cause: 'execute', label: 'Delete fillet', command: del, at: new Date(0).toISOString() }],
      MAIN_BRANCH,
    );

    const bundle = await submitted(seed, s, 'A boss on the upright, and a pair.');
    golden('bracket', bundle);
    await expectImages(seed, bundle);

    expect(bundle.commands.batches.items.map((b) => b.label)).toEqual([
      'Add a boss',
      'Smaller fillet',
      'Aluminium',
      'Two brackets',
    ]);
    expect(bundle.commands.batches.items[1]!.commands[0]!.summary).toBe(
      'Edited Fillet 1: radius 4 mm to 2 mm',
    );
    expect(bundle.commands.batches.items[0]!.commands[1]!.summary).toBe(
      'Added extrude Boss (add, blind 5 mm) from Boss sketch',
    );
    const part = bundle.features.parts[0]!;
    expect(part.items.items.map((i) => [i.id, i.changes])).toEqual([
      ['fillet#1', ['edited']],
      ['sketch#3', ['added']],
      ['extrude#2', ['added']],
    ]);
    expect(part.fields).toEqual([{ path: 'material', before: 'none', after: '"aluminium-6061"' }]);
    expect(bundle.features.assemblies[0]!.items.items.map((i) => i.id)).toEqual([
      'inst#1',
      'inst#2',
    ]);
    const body = bundle.measurements.bodies.items[0]!;
    expect(body.change).toBe('changed');
    expect(body.base!.mass).toBeNull();
    expect(body.head!.mass).toBeGreaterThan(0);
    expect(bundle.measurements.interference[0]!.head).toHaveLength(1);
    expect(bundle.merge!.dropped.items.map((d) => d.label)).toEqual(['Smaller fillet']);
    expect(bundle.regen.counts.head.errors).toBe(0);
  });
});

describe('the cabinet', () => {
  it('the shelf raised, a thicker back, a kerf, a price for the plywood and a rename', async () => {
    const { seed, s } = await start(cabinetDocument());
    const shelf = feature(s, 'sketch#5') as unknown as { plane: Record<string, unknown> };
    const plane = shelf.plane;
    ok(
      await s.apply({
        label: 'Raise the shelf',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: { ...shelf, plane: { ...plane, origin: [0, 0, 16 * 25.4] } } as never,
          },
        ],
      }),
    );
    const back = feature(s, 'extension#6') as unknown as { params: Record<string, unknown> };
    ok(
      await s.apply({
        label: 'Thicker back',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: { ...back, params: { ...back.params, stock: 'us-ply-23-32' } } as never,
          },
        ],
      }),
    );
    ok(
      await s.apply({
        label: 'Settings',
        commands: [
          { type: 'setDomainData', namespace: 'wood', schemaVersion: 1, data: { kerf: mm(3) } },
          {
            type: 'setDomainData',
            namespace: 'stock',
            schemaVersion: 1,
            data: {
              overrides: {
                'us-ply-23-32': { price: { amount: 52, per: 'sheet', currency: 'USD' } },
              },
            },
          },
          { type: 'renameFeature', partId: PART, featureId: 'extension#6', name: 'Back panel' },
        ],
      }),
    );
    const bundle = await submitted(seed, s, 'Shelf at 16 inches.');
    golden('cabinet', bundle);
    await expectImages(seed, bundle);

    expect(bundle.domains.map((d) => [d.namespace, d.change, d.lines])).toEqual([
      [
        'stock',
        'added',
        ['Stock override added for 3/4" plywood (us-ply-23-32): price 52 USD per sheet'],
      ],
      ['wood', 'added', ['Saw kerf: not set to 3 mm']],
    ]);
    const items = bundle.features.parts[0]!.items.items;
    expect(items.find((i) => i.id === 'extension#6')).toMatchObject({
      changes: ['renamed', 'edited'],
      summary:
        'Renamed Back to Back panel; Edited board Back panel: params.stock "us-ply-7-32" to "us-ply-23-32"',
    });
    expect(items.find((i) => i.id === 'sketch#5')!.fields[0]!.path).toBe('plane.origin[2]');
    // The back moved to 3/4" plywood in the cut list, and the sides' rabbets for it grew.
    expect(
      bundle.quantities.rows.items.map((r) => [
        r.item,
        r.base?.quantity ?? 0,
        r.head?.quantity ?? 0,
      ]),
    ).toEqual([
      ['Back panel', 0, 1],
      ['Back', 1, 0],
    ]);
    expect(
      bundle.measurements.bodies.items.filter((b) => b.change === 'changed').map((b) => b.name),
    ).toEqual(['Left side', 'Right side', 'Shelf', 'Back panel']);
    expect(bundle.merge).toMatchObject({ ok: true, changed: true, dropped: { items: [] } });
  });
});

/** The shed's edits on a session of the given engine kind, submitted. */
async function shedBundle(
  engine: 'in-process' | 'worker',
): Promise<{ seed: Seeded; bundle: ReviewBundle }> {
  const { seed, s } = await start(shedDocument(), engine);
  const window = feature(s, 'extension#5') as unknown as { expressions: Record<string, unknown> };
  const data = s.document.domains!.construction!.data as Record<string, unknown>;
  ok(
    await s.apply({
      label: 'Move window 1',
      commands: [
        {
          type: 'editFeature',
          partId: PART,
          feature: { ...window, expressions: { ...window.expressions, position: IN(60) } } as never,
        },
      ],
    }),
  );
  ok(
    await s.apply({
      label: 'Studs at 24 inches',
      commands: [
        {
          type: 'setDomainData',
          namespace: 'construction',
          schemaVersion: 1,
          data: { ...data, framing: { spacing: IN(24) } },
        },
      ],
    }),
  );
  return { seed, bundle: await submitted(seed, s, 'Window 1 at 60 inches; 24 inch centres.') };
}

describe('the shed', () => {
  /** The in-process bundle, for the worker test's byte-for-byte comparison. */
  let inProcess: ReviewBundle | undefined;

  it('a window moved and the studs at 24 inches', async () => {
    const { seed, bundle } = await shedBundle('in-process');
    inProcess = bundle;
    golden('shed', bundle, 'shape');
    await expectImages(seed, bundle);

    expect(bundle.domains).toEqual([
      {
        namespace: 'construction',
        change: 'changed',
        lines: ['Framing spacing: not set to 24 in'],
        omitted: 0,
      },
    ]);
    expect(bundle.quantities.rows.items.some((r) => r.list === 'takeoff Part 1')).toBe(true);
  }, 120_000);

  it('is the same bundle when the session and the builder run their kernels in workers', async () => {
    const { seed, bundle } = await shedBundle('worker');
    golden('shed', bundle, 'shape');
    await expectImages(seed, bundle);
    // On one runtime, the same bytes: every number and every image hash.
    if (inProcess !== undefined) expect(normalised(bundle)).toEqual(normalised(inProcess));
  }, 180_000);
});

describe('staleness', () => {
  it('a write after the submit makes the bundle stale', async () => {
    const { seed, s } = await start(bracketDocument());
    ok(
      await s.apply({
        label: 'Thicker',
        commands: [{ type: 'setVariable', name: 'thickness', expression: mm(8) }],
      }),
    );
    const bundle = await submitted(seed, s, '');
    const info = await s.info();
    expect(
      isStale(bundle, {
        branch: info.branch,
        revision: info.revision,
        baseVersion: info.baseVersion,
      }),
    ).toBe(false);
    ok(
      await s.apply({
        label: 'Thinner',
        commands: [{ type: 'setVariable', name: 'thickness', expression: mm(5) }],
      }),
    );
    const now = await s.info();
    expect(isStale(bundle, { branch: now.branch, revision: now.revision })).toBe(true);
    expect(now.bundle).toEqual({ revision: bundle.key.headRevision, stale: true });
    // Another base is stale too, whatever the revision.
    expect(
      isStale(bundle, { branch: info.branch, revision: info.revision, baseVersion: 'other' }),
    ).toBe(true);
  });
});

describe('a scripted feature', () => {
  it('shows its script in full, and its regen error', async () => {
    const base = bracketDocument();
    const source = 'export default function build(api) {\n  return api.box(10, 10, 10);\n}\n';
    let head = base;
    const commands: Command[] = [
      {
        type: 'setScript',
        script: { id: 'script#1', name: 'Block', language: 'js', apiVersion: 1, source },
      },
      {
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
      } as Command,
    ];
    for (const c of commands) {
      const r = applyCommand(head, c);
      if (!r.ok) throw new Error(r.error.message);
      head = r.value.document;
    }
    const engine = await startEngine('in-process', { heapThresholdBytes: 512 * 1024 * 1024 });
    try {
      const { bundle, images } = await buildBundle({
        key: { documentId: base.id, branch: 'b', baseVersion: 'v', headRevision: 2 },
        base,
        head,
        log: [
          {
            revision: 2,
            cause: 'execute',
            label: 'A scripted block',
            command: { type: 'batch', commands },
          },
        ],
        engine,
        imageSize: SIZE,
      });
      expect(bundle.scripts).toEqual([
        {
          scriptId: 'script#1',
          name: 'Block',
          language: 'js',
          apiVersion: 1,
          change: 'added',
          source,
          truncated: false,
          hiddenCharacters: false,
          features: [`${PART}/scripted#1`],
        },
      ]);
      expect(bundle.commands.batches.items[0]!.commands.map((c) => c.summary)).toEqual([
        "Added script Block (js, 3 lines; source in the bundle's scripts)",
        'Added scripted feature Block (script Block, 0 parameters, seed 0)',
      ]);
      expect(bundle.regen.new.items[0]).toMatchObject({
        featureId: 'scripted#1',
        severity: 'error',
      });
      expect(images.size).toBeGreaterThan(0);
      expect(readBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
    } finally {
      await engine.close();
    }
  });
});
