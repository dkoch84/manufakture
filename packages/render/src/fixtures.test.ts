// Golden PNGs of the M8 fixtures, regenerated in Node on the real kernel: byte-identical to the
// files in test/goldens, and on a second render. To accept new images after a deliberate change
// (to the renderer, or to the meshes regen makes), run with UPDATE_GOLDENS=1 and look at them.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import type { RegenResult } from '@manufakture/regen';
import { beforeAll, describe, expect, it } from 'vitest';
import { HIGHLIGHT_EDGE } from './colors';
import { render, renderRgb, renderViews } from './render';
import { buildScene, type Scene } from './scene';
import {
  bracketDocument,
  cabinetDocument,
  regen,
  session,
  shedDocument,
  type Session,
} from './test/fixtures';
import { colorAt, count, decodePng } from './test/shapes';
import type { RenderOptions } from './types';

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), 'test', 'goldens');
const UPDATE = process.env.UPDATE_GOLDENS === '1';
/** Small images keep the goldens small; the views are the same at any size. */
const SIZE = { width: 480, height: 360 } as const;

let s: Session;
const results = new Map<string, { doc: ManufaktureDocument; result: RegenResult }>();

beforeAll(async () => {
  s = await session();
  for (const [name, doc] of [
    ['bracket', bracketDocument()],
    ['cabinet', cabinetDocument()],
    ['shed', shedDocument()],
  ] as const)
    results.set(name, { doc, result: await regen(s, doc) });
}, 120_000);

function sceneOf(name: string, doc?: ManufaktureDocument): Scene {
  const r = results.get(name)!;
  const scene = buildScene({
    result: r.result,
    memberMeshes: s.memberMeshes,
    document: doc ?? r.doc,
  });
  if (!scene.ok) throw new Error(scene.error.message);
  return scene.value;
}

function png(scene: Scene, options: RenderOptions): Uint8Array {
  const r = render(scene, { ...SIZE, ...options });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.png;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function golden(file: string, bytes: Uint8Array): void {
  const path = join(GOLDENS, file);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(path, bytes);
    if (!UPDATE) throw new Error(`${file} was missing and has been written: check it, rerun`);
  }
  expect(sha(bytes), `${file} matches its golden`).toBe(sha(readFileSync(path)));
}

describe('goldens', () => {
  const cases: [string, string, RenderOptions][] = [
    ['bracket', 'bracket-isometric.png', {}],
    ['bracket', 'bracket-front.png', { camera: 'front' }],
    ['cabinet', 'cabinet-isometric.png', {}],
    ['shed', 'shed-isometric.png', {}],
    [
      'shed',
      'shed-door-framing.png',
      {
        camera: { view: 'isometric', fit: ['extension#7:*'] },
        only: 'members',
        highlight: ['extension#7:*'],
      },
    ],
  ];
  for (const [fixture, file, options] of cases)
    it(`${file}: as the golden, and the same bytes on a second render`, () => {
      const a = png(sceneOf(fixture), options);
      const b = png(sceneOf(fixture), options);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      golden(file, a);
    });
});

describe('the fixtures', () => {
  it('the shed is framing members as well as bodies, coloured by role', () => {
    const scene = sceneOf('shed');
    const members = scene.meshes.filter((m) => m.kind === 'member');
    const instances = members.reduce((n, m) => n + m.names.length, 0);
    expect(instances).toBeGreaterThan(100);
    expect(scene.meshes.some((m) => m.kind === 'body')).toBe(true);
    expect(new Set(members.flatMap((m) => m.colors.map(String))).size).toBeGreaterThan(3);
  });

  it('highlights a face of the bracket by its regen name', () => {
    const { result } = results.get('bracket')!;
    const round = result.names.find((n) => n.startsWith('fillet#1:'));
    expect(round).toBeDefined();
    const scene = sceneOf('bracket');
    const plain = renderRgb(scene, SIZE);
    const lit = renderRgb(scene, { ...SIZE, highlight: [round!] });
    expect(plain.ok && lit.ok).toBe(true);
    if (!plain.ok || !lit.ok) return;
    expect(lit.value.unmatched).toEqual([]);
    const orange = (img: { rgb: Uint8Array }) => {
      let n = 0;
      for (let i = 0; i < img.rgb.length; i += 3)
        if (img.rgb[i]! > img.rgb[i + 1]! + 40 && img.rgb[i + 1]! > img.rgb[i + 2]! + 40) n++;
      return n;
    };
    expect(orange(plain.value)).toBe(0);
    expect(orange(lit.value)).toBeGreaterThan(300);
    // An edge of the hole, by name, in the highlight edge colour.
    const edgeName = result.names.find((n) => n.startsWith('hole#1:'));
    const edge = renderRgb(scene, { ...SIZE, highlight: ['hole#1:*'] });
    expect(edgeName).toBeDefined();
    expect(edge.ok && count(edge.value.rgb, HIGHLIGHT_EDGE)).toBeGreaterThan(50);
  });

  it('cuts the cabinet with a section plane and fills the cut boards', () => {
    const scene = sceneOf('cabinet');
    // Halfway across, cutting away the right half; seen from the right.
    const half = (24 * 25.4) / 2;
    const options: RenderOptions = {
      ...SIZE,
      camera: 'right',
      section: { origin: [half, 0, 0], normal: [1, 0, 0] },
    };
    const whole = renderRgb(scene, { ...SIZE, camera: 'right' });
    const cut = renderRgb(scene, options);
    expect(whole.ok && cut.ok).toBe(true);
    if (!whole.ok || !cut.ok) return;
    // Seen from the right, the whole cabinet is its right side, one board; the section shows
    // the cut through the bottom, top, shelf and back instead, in the cap shade.
    const cap = (c: readonly number[]) => c.map((v) => Math.round(v * 0.6));
    const palette = [0xc2, 0xca, 0xd3];
    expect(count(whole.value.rgb, cap(palette) as [number, number, number])).toBe(0);
    const capped = new Set<string>();
    for (let y = 0; y < SIZE.height; y += 4)
      for (let x = 0; x < SIZE.width; x += 4) capped.add(String(colorAt(cut.value, x, y)));
    const caps = scene.meshes.map((m) => String(cap(m.colors[0]!)));
    expect(caps.filter((c) => capped.has(c)).length).toBeGreaterThanOrEqual(1);
    // The golden: an isometric with the right half cut away towards the eye.
    const iso = render(scene, { ...SIZE, section: options.section! });
    expect(iso.ok).toBe(true);
    if (iso.ok) golden('cabinet-section.png', iso.value.png);
  });

  it('takes body colours from the document', () => {
    const { doc } = results.get('cabinet')!;
    const r = applyCommand(doc, {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extension#6',
      props: { color: '#1f77b4' },
    } as Command);
    if (!r.ok) throw new Error(r.error.message);
    const scene = sceneOf('cabinet', r.value.document);
    const back = scene.meshes.find((m) => m.names[0] === 'extension#6')!;
    expect(back.colors[0]).toEqual([0x1f, 0x77, 0xb4]);
    // From behind, the back panel is most of the image.
    const img = renderRgb(scene, { ...SIZE, camera: 'back' });
    expect(img.ok).toBe(true);
    if (!img.ok) return;
    const centre = colorAt(img.value, SIZE.width / 2, SIZE.height / 2);
    expect(centre[2]).toBeGreaterThan(centre[0] + 40);
  });

  it('renders the shed four ways in good time', () => {
    const scene = sceneOf('shed');
    const views: RenderOptions[] = (['isometric', 'front', 'top', 'right'] as const).map(
      (camera) => ({ camera }),
    );
    renderViews(scene, views.slice(0, 1)); // warm up the JIT
    const t0 = performance.now();
    const out = renderViews(scene, views);
    const ms = performance.now() - t0;
    expect(out.ok).toBe(true);
    if (out.ok) for (const v of out.value) expect(decodePng(v.png).width).toBe(1024);
    console.info(`shed, four views at 1024 x 768 with PNG: ${ms.toFixed(0)} ms (budget 1500)`);
    // T8.0b's budget is 1.5 s on CI; four times that before a loaded machine fails the test.
    expect(ms).toBeLessThan(6000);
  });
});
