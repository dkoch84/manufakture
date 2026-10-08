// Approach 1, measured: the software rasteriser on the three fixtures and the house, four views
// each at 1024 x 768, plus a tiled stress scene of houses. Per view: one warm-up render, then
// RUNS timed renders (median and spread), the PNG encode, its size, and the PNG's SHA-256 on every
// run (all must match within the process). The hashes are kept in results/software-hashes.json;
// a rerun of this file compares against them, which is the cross-process determinism check
// (fresh kernel, fresh regen, fresh JIT).
//
// Writes results/software.json, full-size renders to the scratch directory, and the samples kept
// in docs/spikes/T8.0b-render/.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  DOCUMENTS,
  FIXTURE_NAMES,
  STRESS_NAMES,
  regen,
  sceneOf,
  session,
  tiled,
  type FixtureName,
  type Scene,
} from './fixtures';
import { encodePng } from './png';
import { VIEWS, rasterize, type RasterOptions, type View } from './raster';
import { IMAGES, RESULTS, SCRATCH, median, round, timed, writeImage, writeResult } from './results';

const RUNS = Number(process.env.RENDER_RUNS ?? 5);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Row {
  fixture: string;
  view: string;
  variant: string;
  triangles: number;
  segments: number;
  mmPerPixel: number;
  renderMs: { median: number; min: number; max: number };
  phasesMs: Record<string, number>;
  encodeMs: number;
  pngBytes: number;
  /** The same image at zlib level 6 (the default is 9). */
  level6: { encodeMs: number; pngBytes: number };
  sha256: string;
  identicalRuns: boolean;
}

function measure(
  fixture: string,
  scene: Scene,
  view: View,
  variant: string,
  options: Partial<RasterOptions> = {},
): { row: Row; png: Uint8Array } {
  rasterize(scene, view, options); // warm-up
  const times: number[] = [];
  const hashes = new Set<string>();
  const phases: Record<string, number[]> = {};
  const encodes: number[] = [];
  const encodes6: number[] = [];
  let png6: Uint8Array = new Uint8Array();
  let png: Uint8Array = new Uint8Array();
  let last = rasterize(scene, view, options);
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = rasterize(scene, view, options);
    times.push(performance.now() - t0);
    for (const [k, v] of Object.entries(last.stats.ms)) (phases[k] ??= []).push(v);
    const t1 = performance.now();
    png = encodePng(last.rgb, last.width, last.height);
    encodes.push(performance.now() - t1);
    hashes.add(sha(png));
    const t2 = performance.now();
    png6 = encodePng(last.rgb, last.width, last.height, 6);
    encodes6.push(performance.now() - t2);
  }
  return {
    png,
    row: {
      fixture,
      view: view.name,
      variant,
      triangles: last.stats.triangles,
      segments: last.stats.segments,
      mmPerPixel: round(last.stats.mmPerPixel, 4),
      renderMs: {
        median: round(median(times)),
        min: round(Math.min(...times)),
        max: round(Math.max(...times)),
      },
      phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, round(median(v))])),
      encodeMs: round(median(encodes)),
      pngBytes: png.length,
      level6: { encodeMs: round(median(encodes6)), pngBytes: png6.length },
      sha256: [...hashes][0]!,
      identicalRuns: hashes.size === 1,
    },
  };
}

it('renders every fixture and view, timed, and checks determinism', async () => {
  const s = await session();
  const rows: Row[] = [];
  const regens: Record<string, unknown> = {};
  const scenes = new Map<FixtureName, Scene>();
  for (const name of [...FIXTURE_NAMES, ...STRESS_NAMES]) {
    const doc = DOCUMENTS[name]();
    const [result, regenMs] = await timed(() => regen(s, doc));
    const [scene, sceneMs] = await timed(() => sceneOf(result, s.memberMeshes));
    scenes.set(name, scene);
    const members = (result.parts[0]!.members ?? []).reduce((n, set) => n + set.count, 0);
    regens[name] = {
      regenMs: round(regenMs),
      sceneMs: round(sceneMs),
      bodies: result.parts[0]!.bodies.length,
      members,
      memberShapes: result.memberMeshes?.added.length ?? 0,
      triangles: scene.triangles,
      drawCalls: scene.meshes.length,
      instances: scene.instances,
    };
    for (const view of VIEWS) {
      const { row, png } = measure(name, scene, view, 'default');
      rows.push(row);
      writeImage(SCRATCH, `software-${name}-${view.name}.png`, png);
      if (view.name === 'iso') writeImage(IMAGES, `software-${name}-iso.png`, png);
    }
  }

  // Variants on the iso view: supersampling 1, 2 (default) and 3; no silhouette pass; no edges.
  const variants: [string, Partial<RasterOptions>][] = [
    ['ss1', { ss: 1, lineWidth: 1 }],
    ['ss3', { ss: 3 }],
    ['no-outline', { outline: false }],
    ['no-edges-no-outline', { edges: false, outline: false }],
  ];
  for (const name of [...FIXTURE_NAMES, ...STRESS_NAMES])
    for (const [variant, options] of variants)
      rows.push(measure(name, scenes.get(name)!, VIEWS[0]!, variant, options).row);

  // The shed's framing alone (layer bodies hidden), and the door's members highlighted.
  const shed = scenes.get('shed')!;
  const framing: Scene = { ...shed, meshes: shed.meshes.filter((m) => m.kind === 'member') };
  const f = measure('shed', framing, VIEWS[0]!, 'framing-only');
  rows.push(f.row);
  writeImage(SCRATCH, 'software-shed-framing-iso.png', f.png);
  const door = new Set(
    shed.meshes.flatMap((m) => m.names.filter((n) => n.startsWith('extension#7:'))),
  );
  expect(door.size).toBeGreaterThan(4);
  const h = measure('shed', framing, VIEWS[0]!, 'framing-highlight-door', { highlight: door });
  rows.push(h.row);
  writeImage(IMAGES, 'software-shed-framing-highlight.png', h.png);

  // Stress: houses on a grid, n x n copies.
  const house = scenes.get('house')!;
  const stress: Record<string, unknown>[] = [];
  for (const n of [1, 2, 3, 4]) {
    const scene = tiled(house, n);
    const { row, png } = measure(`house x${n * n}`, scene, VIEWS[0]!, 'tiled');
    rows.push(row);
    stress.push({
      copies: n * n,
      instances: scene.instances,
      triangles: scene.triangles,
      renderMs: row.renderMs,
      phasesMs: row.phasesMs,
      encodeMs: row.encodeMs,
      pngBytes: row.pngBytes,
    });
    if (n === 4) writeImage(SCRATCH, 'software-house-x16-iso.png', png);
  }

  // Cross-process determinism: compare with the hashes of the previous run, then store these.
  const hashFile = join(RESULTS, 'software-hashes.json');
  const previous: Record<string, string> = existsSync(hashFile)
    ? (JSON.parse(readFileSync(hashFile, 'utf8')) as Record<string, string>)
    : {};
  const current = Object.fromEntries(
    rows.map((r) => [`${r.fixture}/${r.view}/${r.variant}`, r.sha256]),
  );
  const compared = Object.keys(current).filter((k) => k in previous);
  const differing = compared.filter((k) => previous[k] !== current[k]);
  writeFileSync(hashFile, JSON.stringify(current, null, 2) + '\n');

  writeResult('software', {
    runs: RUNS,
    regens,
    rows,
    stress,
    determinism: {
      allRunsIdentical: rows.every((r) => r.identicalRuns),
      previousRunCompared: compared.length,
      previousRunDiffering: differing,
    },
  });
  for (const r of rows)
    console.log(
      `${r.fixture} ${r.view} ${r.variant}: ${r.renderMs.median} ms (+${r.encodeMs} encode; level 6 ${r.level6.encodeMs} ms ${r.level6.pngBytes} B), ${r.pngBytes} B, ${r.triangles} tris`,
    );
  console.log(`compared with previous run: ${compared.length}, differing: ${differing.length}`);
  expect(rows.every((r) => r.identicalRuns)).toBe(true);
  expect(differing).toEqual([]);
  await s.engine.dispose();
});
