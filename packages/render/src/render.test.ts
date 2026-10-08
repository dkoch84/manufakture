// The renderer on hand-made scenes: cameras, limits, highlight, section, fit, hide, instances.

import { describe, expect, it } from 'vitest';
import { BACKGROUND, HIGHLIGHT, HIGHLIGHT_EDGE } from './colors';
import { encodePng } from './png';
import { render, renderRgb, renderViews } from './render';
import type { Scene } from './scene';
import { boxMesh, colorAt, count, decodePng, pixelIs } from './test/shapes';
import { MAX_IMAGE_SIDE, type RenderOptions } from './types';

const cube = (): Scene => ({ meshes: [boxMesh('extrude#1', [0, 0, 0], [10, 10, 10])] });
const small: RenderOptions = { width: 160, height: 120 };

function rgb(scene: Scene, options: RenderOptions) {
  const r = renderRgb(scene, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The distinct colours of an image, with their pixel counts. */
function colours(img: { rgb: Uint8Array }): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < img.rgb.length; i += 3) {
    const k = `${img.rgb[i]},${img.rgb[i + 1]},${img.rgb[i + 2]}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

describe('encodePng', () => {
  it('writes a PNG that decodes to the same pixels', () => {
    const rgb = new Uint8Array(7 * 5 * 3).map((_, i) => (i * 37) & 0xff);
    const png = encodePng(rgb, 7, 5);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const back = decodePng(png);
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(back.rgb).toEqual(rgb);
  });
});

describe('render', () => {
  it('draws the three visible faces of a box in three shades, edges in ink', () => {
    const img = rgb(cube(), { ...small, edges: false, outlines: false, supersample: 1 });
    const c = colours(img);
    c.delete(BACKGROUND.join(','));
    // Supersampling off and no lines: exactly the three faces the isometric sees.
    expect(c.size).toBe(3);
    const counts = [...c.values()];
    expect(Math.min(...counts)).toBeGreaterThan(500);
  });

  it('fits the model with a margin and reports the scale', () => {
    const r = render(cube(), { ...small, camera: 'front' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Front: 10 mm across, 120 - 2 x 24 px high, so 72 px for 10 mm.
    expect(r.value.mmPerPixel).toBeCloseTo(10 / 72, 9);
    const img = decodePng(r.value.png);
    expect(pixelIs(img, 80, 60, BACKGROUND)).toBe(false);
    expect(pixelIs(img, 80, 10, BACKGROUND)).toBe(true);
    expect(pixelIs(img, 10, 60, BACKGROUND)).toBe(true);
  });

  it('gives the same bytes every time', () => {
    const scene = cube();
    const a = render(scene, { highlight: ['extrude#1:z+'] });
    const b = render(cube(), { highlight: ['extrude#1:z+'] });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(Buffer.from(a.value.png).equals(Buffer.from(b.value.png))).toBe(true);
  });

  it('refuses images over the size limit, and too many images', () => {
    const big = render(cube(), { width: MAX_IMAGE_SIDE + 1, height: 10 });
    expect(big).toMatchObject({ ok: false, error: { code: 'too-large' } });
    const tall = render(cube(), { width: 10, height: MAX_IMAGE_SIDE + 1 });
    expect(tall).toMatchObject({ ok: false, error: { code: 'too-large' } });
    expect(render(cube(), { width: MAX_IMAGE_SIDE, height: 8, supersample: 1 }).ok).toBe(true);
    const many = renderViews(
      cube(),
      Array.from({ length: 9 }, () => small),
    );
    expect(many).toMatchObject({ ok: false, error: { code: 'too-large' } });
    const eight = renderViews(
      cube(),
      Array.from({ length: 8 }, () => ({ ...small, width: 16 })),
    );
    expect(eight.ok && eight.value.length).toBe(8);
  });

  it('refuses bad sizes and cameras as data', () => {
    expect(render(cube(), { width: 0 })).toMatchObject({ error: { code: 'invalid-options' } });
    expect(render(cube(), { width: 10.5 })).toMatchObject({ error: { code: 'invalid-options' } });
    expect(render(cube(), { supersample: 4 })).toMatchObject({
      error: { code: 'invalid-options' },
    });
    expect(render(cube(), { camera: { direction: [0, 0, 0] } })).toMatchObject({
      error: { code: 'invalid-camera' },
    });
    expect(render(cube(), { camera: { direction: [1, 0, 0], up: [2, 0, 0] } })).toMatchObject({
      error: { code: 'invalid-camera' },
    });
    expect(render(cube(), { camera: { position: [1, 1, 1], target: [1, 1, 1] } })).toMatchObject({
      error: { code: 'invalid-camera' },
    });
    expect(render(cube(), { camera: 'sideways' as 'front' })).toMatchObject({
      error: { code: 'invalid-camera' },
    });
    expect(render(cube(), { section: { origin: [0, 0, 0], normal: [0, 0, 0] } })).toMatchObject({
      error: { code: 'invalid-options' },
    });
    expect(render(cube(), { camera: 42 as unknown as 'front' })).toMatchObject({
      error: { code: 'invalid-camera' },
    });
    expect(render(cube(), null as unknown as RenderOptions)).toMatchObject({
      error: { code: 'invalid-options' },
    });
    expect(render(cube(), [] as unknown as RenderOptions)).toMatchObject({
      error: { code: 'invalid-options' },
    });
  });

  it('frames degenerate fits and tiny extents quickly, at a bounded scale', () => {
    const big = (): Scene => ({ meshes: [boxMesh('extrude#1', [0, 0, 0], [20000, 20000, 5000])] });
    // e8 runs along Z: from the top it is a point.
    for (const camera of [
      { view: 'top', fit: ['extrude#1:e8'] },
      { view: 'top', extent: 1e-6 },
      { view: 'isometric', extent: 1e-9 },
    ] as const) {
      const start = performance.now();
      const r = render(big(), { camera });
      expect(performance.now() - start).toBeLessThan(3000);
      expect(r.ok).toBe(true);
      // Widened to 1e-4 of the diagonal (about 2.9 mm here), not a nanometre.
      if (r.ok) expect(r.value.mmPerPixel).toBeGreaterThan(1e-3);
    }
  });

  it('a given direction equals the preset it names; a position and target too', () => {
    const preset = render(cube(), { ...small, camera: 'isometric' });
    const dir = render(cube(), { ...small, camera: { direction: [-1, 1, -1], up: [0, 0, 1] } });
    const look = render(cube(), {
      ...small,
      camera: { position: [11, -1, 11], target: [10, 0, 10] },
    });
    expect(preset.ok && dir.ok && look.ok).toBe(true);
    if (preset.ok && dir.ok && look.ok) {
      expect(Buffer.from(dir.value.png).equals(Buffer.from(preset.value.png))).toBe(true);
      expect(Buffer.from(look.value.png).equals(Buffer.from(preset.value.png))).toBe(true);
    }
    // Looking straight down with no up given: Y up, as `top`.
    const down = render(cube(), { ...small, camera: { direction: [0, 0, -1] } });
    const top = render(cube(), { ...small, camera: 'top' });
    if (down.ok && top.ok)
      expect(Buffer.from(down.value.png).equals(Buffer.from(top.value.png))).toBe(true);
  });

  it('highlights a body, a face and an edge by name, and reports names that match nothing', () => {
    const scene: Scene = {
      meshes: [
        boxMesh('extrude#1', [0, 0, 0], [10, 10, 10]),
        boxMesh('extrude#2', [20, 0, 0], [30, 10, 10]),
      ],
    };
    const plain = rgb(scene, small);
    // The highlight colour lit: the top face of an isometric is the brightest.
    const lit = (img: { rgb: Uint8Array }) => {
      let n = 0;
      for (let i = 0; i < img.rgb.length; i += 3) {
        const [r, g, b] = [img.rgb[i]!, img.rgb[i + 1]!, img.rgb[i + 2]!];
        if (r > g + 40 && g > b + 40) n++;
      }
      return n;
    };
    expect(lit(plain)).toBe(0);
    const body = rgb(scene, { ...small, highlight: ['extrude#2'] });
    const face = rgb(scene, { ...small, highlight: ['part#1/extrude#1:z+'] });
    const both = rgb(scene, { ...small, highlight: ['extrude#*'] });
    expect(lit(face)).toBeGreaterThan(200);
    expect(lit(body)).toBeGreaterThan(lit(face));
    expect(lit(both)).toBeGreaterThan(lit(body));
    const edge = rgb(scene, { ...small, highlight: ['extrude#1:e3'] });
    expect(count(edge.rgb, HIGHLIGHT_EDGE)).toBeGreaterThan(10);
    expect(count(plain.rgb, HIGHLIGHT_EDGE)).toBe(0);
    const r = render(scene, { ...small, highlight: ['extrude#1', 'sketch#9', 'nope*'] });
    expect(r.ok && r.value.unmatched).toEqual(['sketch#9', 'nope*']);
    // The highlight colour itself, unshaded, never appears: faces are always lit.
    expect(count(both.rgb, HIGHLIGHT)).toBeLessThan(count(both.rgb, BACKGROUND));
  });

  it('cuts at a section plane and fills the cut', () => {
    const front = {
      ...small,
      camera: 'front' as const,
      supersample: 1,
      outlines: false,
      edges: false,
    };
    const whole = rgb(cube(), front);
    // Cut away x > 5: the right half of the front view is gone.
    const cut = rgb(cube(), { ...front, section: { origin: [5, 0, 0], normal: [1, 0, 0] } });
    // Same framing as the whole box (the fit ignores the section).
    expect(cut.mmPerPixel).toBe(whole.mmPerPixel);
    const row = 60;
    expect(pixelIs(whole, 100, row, BACKGROUND)).toBe(false);
    expect(pixelIs(cut, 100, row, BACKGROUND)).toBe(true);
    expect(pixelIs(cut, 60, row, BACKGROUND)).toBe(false);
    // Cut away the front half (y < 5) and look from the front: the whole view is the cut face,
    // in the body colour at the cap shade.
    const cap: [number, number, number] = [0xc2, 0xca, 0xd3].map((c) => Math.round(c * 0.6)) as [
      number,
      number,
      number,
    ];
    expect(count(whole.rgb, cap)).toBe(0);
    const capped = rgb(cube(), { ...front, section: { origin: [0, 5, 0], normal: [0, -1, 0] } });
    expect(count(capped.rgb, cap)).toBe(160 * 120 - count(whole.rgb, BACKGROUND));
    // In an isometric too, with the cut's outline inked.
    const iso = rgb(cube(), {
      ...small,
      section: { origin: [5, 5, 5], normal: [1, -1, 1] },
    });
    expect(count(iso.rgb, cap)).toBeGreaterThan(1000);
    const isoWhole = rgb(cube(), small);
    expect(count(isoWhole.rgb, cap)).toBe(0);
  });

  it('frames named items, or an extent around a target', () => {
    const scene: Scene = {
      meshes: [
        boxMesh('extrude#1', [0, 0, 0], [10, 10, 10]),
        boxMesh('extrude#2', [1000, 0, 0], [1010, 10, 10]),
      ],
    };
    const all = render(scene, { ...small, camera: 'front' });
    const one = render(scene, { ...small, camera: { view: 'front', fit: ['extrude#2'] } });
    const face = render(scene, { ...small, camera: { view: 'front', fit: ['extrude#2:z+'] } });
    expect(all.ok && one.ok && face.ok).toBe(true);
    if (!all.ok || !one.ok || !face.ok) return;
    expect(one.value.mmPerPixel).toBeCloseTo(10 / 72, 9);
    expect(all.value.mmPerPixel).toBeGreaterThan(5);
    // The top face seen edge-on from the front: 10 mm wide, no height.
    expect(face.value.mmPerPixel).toBeCloseTo(10 / 112, 9);
    const img = decodePng(one.value.png);
    expect(pixelIs(img, 80, 60, BACKGROUND)).toBe(false);
    expect(render(scene, { camera: { view: 'front', fit: ['extrude#3'] } })).toMatchObject({
      ok: false,
      error: { code: 'unknown-name' },
    });
    const extent = render(scene, {
      ...small,
      camera: { position: [5, -100, 5], target: [5, 0, 5], extent: 40 },
    });
    expect(extent.ok && extent.value.mmPerPixel).toBeCloseTo(40 / 120, 9);
    expect(render(scene, { camera: { view: 'front', extent: -1 } })).toMatchObject({
      error: { code: 'invalid-options' },
    });
  });

  it('hides bodies by name, and says when nothing is left', () => {
    const scene: Scene = {
      meshes: [
        boxMesh('extrude#1', [0, 0, 0], [10, 10, 10]),
        boxMesh('extrude#2', [1000, 0, 0], [1010, 10, 10]),
      ],
    };
    const hidden = render(scene, { ...small, camera: 'front', hide: ['extrude#1'] });
    expect(hidden.ok && hidden.value.mmPerPixel).toBeCloseTo(10 / 72, 9);
    expect(render(scene, { hide: ['extrude#*'] })).toMatchObject({ error: { code: 'empty' } });
    expect(render({ meshes: [] })).toMatchObject({ error: { code: 'empty' } });
  });

  it('draws instances through their matrices, mirrored ones included', () => {
    const unit = boxMesh('shape', [0, 0, 0], [1, 1, 1]);
    const at = (x: number, sx = 1) => [sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const members: Scene = {
      meshes: [
        {
          ...unit,
          kind: 'member',
          triangleFaces: null,
          faceNames: [],
          edgeNames: [],
          matrices: new Float32Array([...at(0), ...at(5, -1)]),
          colors: [
            [200, 160, 100],
            [200, 160, 100],
          ],
          names: ['wall#1:stud-1', 'wall#1:stud-2'],
        },
      ],
    };
    const opts = {
      ...small,
      camera: 'front' as const,
      edges: false,
      outlines: false,
      supersample: 1,
    };
    const img = rgb(members, opts);
    // Two unit squares, x 0..1 and 4..5: the span is 5 mm across 112 px.
    expect(img.mmPerPixel).toBeCloseTo(5 / 112, 9);
    expect(pixelIs(img, 30, 60, BACKGROUND)).toBe(false);
    expect(pixelIs(img, 130, 60, BACKGROUND)).toBe(false);
    expect(pixelIs(img, 80, 60, BACKGROUND)).toBe(true);
    // A mirrored instance under a section still shows its outside, not the cut colour.
    const cut = rgb(members, { ...opts, section: { origin: [0, 0.5, 0], normal: [0, -1, 0] } });
    const cap = [200, 160, 100].map((c) => Math.round(c * 0.6)) as [number, number, number];
    expect(pixelIs(cut, 30, 60, cap)).toBe(true);
    expect(pixelIs(cut, 130, 60, cap)).toBe(true);
    const back = rgb(members, { ...opts, section: { origin: [0, 0.5, 0], normal: [0, 1, 0] } });
    expect(pixelIs(back, 30, 60, cap)).toBe(false);
    expect(pixelIs(back, 130, 60, cap)).toBe(false);
    const one = rgb(members, { ...opts, highlight: ['wall#1:stud-2'] });
    expect(pixelIs(one, 30, 60, colorAt(img, 30, 60))).toBe(true);
    expect(pixelIs(one, 130, 60, colorAt(img, 130, 60))).toBe(false);
  });
});
