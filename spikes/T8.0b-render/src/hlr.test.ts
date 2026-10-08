// Approach 2, measured: hidden-line views from the drawing pipeline, rasterised by sharp
// (librsvg) and by the TypeScript stroker, on the three fixtures and the house, four views each,
// plus the shed's and the house's framing elevations (construction domain views: the only way the
// drawing pipeline shows framing members). Per view: the first (uncached) projection, the sheet
// layout, the SVG, then RUNS timed rasterisations with both rasterisers, sizes and hashes. Hashes
// are compared with the previous run's (results/hlr-hashes.json) as in software.test.ts.
//
// Writes results/hlr.json, full-size renders to the scratch directory, and samples to
// docs/spikes/T8.0b-render/.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DOCUMENTS, FIXTURE_NAMES, STRESS_NAMES, regen, session } from './fixtures';
import {
  HLR_VIEWS,
  SHED_ELEVATION,
  SHEET_W,
  hlrViews,
  rasterizeDisplay,
  svgToPngSharp,
  type HlrView,
} from './hlr';
import { IMAGES, RESULTS, SCRATCH, median, round, writeImage, writeResult } from './results';

const RUNS = Number(process.env.RENDER_RUNS ?? 5);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The house's first exterior wall as a framing elevation. */
const HOUSE_ELEVATION: HlrView = {
  name: 'elevation',
  direction: 'front',
  domain: { kind: 'elevation', wall: 'extension#1' },
};

it('draws every fixture and view, timed, and checks determinism', async () => {
  const s = await session();
  const rows: Record<string, unknown>[] = [];
  const hashes: Record<string, string> = {};
  let allIdentical = true;
  for (const name of [...FIXTURE_NAMES, ...STRESS_NAMES]) {
    const doc = DOCUMENTS[name]();
    await regen(s, doc);
    const views =
      name === 'shed'
        ? [...HLR_VIEWS, SHED_ELEVATION]
        : name === 'house'
          ? [...HLR_VIEWS, HOUSE_ELEVATION]
          : HLR_VIEWS;
    for (const v of await hlrViews(s, doc, views)) {
      const sharpMs: number[] = [];
      const tsMs: number[] = [];
      const tsEncode: number[] = [];
      const sharpHashes = new Set<string>();
      const tsHashes = new Set<string>();
      let sharpPng: Uint8Array = new Uint8Array();
      let tsPng: Uint8Array = new Uint8Array();
      await svgToPngSharp(v.svg); // warm-up
      rasterizeDisplay(v.display);
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        sharpPng = await svgToPngSharp(v.svg);
        sharpMs.push(performance.now() - t0);
        sharpHashes.add(sha(sharpPng));
        const ts = rasterizeDisplay(v.display);
        tsMs.push(ts.rasterMs);
        tsEncode.push(ts.encodeMs);
        tsPng = ts.png;
        tsHashes.add(sha(tsPng));
      }
      allIdentical &&= sharpHashes.size === 1 && tsHashes.size === 1;
      hashes[`${name}/${v.name}/sharp`] = [...sharpHashes][0]!;
      hashes[`${name}/${v.name}/ts`] = [...tsHashes][0]!;
      // Model mm per output pixel: the sheet is SHEET_W paper mm over 1024 pixels.
      const mmPerPixel = SHEET_W / 1024 / v.scale;
      rows.push({
        fixture: name,
        view: v.name,
        edges: v.edges,
        mmPerPixel: round(mmPerPixel, 4),
        ms: {
          project: round(v.ms.project),
          layout: round(v.ms.layout),
          svg: round(v.ms.svg, 2),
          sharp: { median: round(median(sharpMs)), min: round(Math.min(...sharpMs)) },
          ts: { median: round(median(tsMs)), min: round(Math.min(...tsMs)) },
          tsEncode: round(median(tsEncode)),
        },
        svgBytes: v.svg.length,
        pngBytes: { sharp: sharpPng.length, ts: tsPng.length },
        identicalRuns: { sharp: sharpHashes.size === 1, ts: tsHashes.size === 1 },
      });
      writeImage(SCRATCH, `hlr-sharp-${name}-${v.name}.png`, sharpPng);
      writeImage(SCRATCH, `hlr-ts-${name}-${v.name}.png`, tsPng);
      writeImage(SCRATCH, `hlr-${name}-${v.name}.svg`, new TextEncoder().encode(v.svg));
      if (v.name === 'iso' && name !== 'house') writeImage(IMAGES, `hlr-${name}-iso.png`, sharpPng);
      if (name === 'shed' && v.name === 'elevation')
        writeImage(IMAGES, 'hlr-shed-elevation.png', sharpPng);
      console.log(name, v.name, JSON.stringify(rows.at(-1)));
    }
  }
  const hashFile = join(RESULTS, 'hlr-hashes.json');
  const previous: Record<string, string> = existsSync(hashFile)
    ? (JSON.parse(readFileSync(hashFile, 'utf8')) as Record<string, string>)
    : {};
  const compared = Object.keys(hashes).filter((k) => k in previous);
  const differing = compared.filter((k) => previous[k] !== hashes[k]);
  writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + '\n');
  writeResult('hlr', {
    runs: RUNS,
    rasterisers: {
      sharp: 'sharp 0.35.5 (libvips 8.18.7, librsvg 2.63.2)',
      ts: 'hlr.ts rasterizeDisplay, 3x3 supersampling',
    },
    rows,
    determinism: {
      allRunsIdentical: allIdentical,
      previousRunCompared: compared.length,
      previousRunDiffering: differing,
    },
  });
  console.log(`compared with previous run: ${compared.length}, differing: ${differing.length}`);
  expect(allIdentical).toBe(true);
  expect(differing).toEqual([]);
  await s.engine.dispose();
});
