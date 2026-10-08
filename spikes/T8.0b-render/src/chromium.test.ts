// Approach 3, the reference, measured: the viewer in headless Chromium (SwiftShader) on the
// three fixtures and the house, four views each. Two browser launches, each opening every
// fixture's bundle once and shooting the four views twice: within a launch, the second round must
// equal the first; across launches, the PNGs are compared too; and with the previous run's
// (results/chromium-hashes.json).
//
// Needs the viewer test build in T80B_VIEWER (default /tmp/t80b-viewer) and Playwright's Chromium
// (README). Writes results/chromium.json and one sample (as JPEG, to keep it small).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VIEWER_DIR, bundleOf, launch, viewerShots } from './chromium';
import { DOCUMENTS, FIXTURE_NAMES, STRESS_NAMES, regen, sceneOf, session } from './fixtures';
import { IMAGES, RESULTS, SCRATCH, median, round, timed, writeImage, writeResult } from './results';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const require = createRequire(import.meta.url);
const sharp: typeof import('sharp').default = require(
  join(import.meta.dirname, '../../../node_modules/.pnpm/node_modules/sharp'),
);
const VIEWS = ['iso', 'front', 'top', 'right'];

it.skipIf(!existsSync(join(VIEWER_DIR, 'viewer.html')))(
  'shoots every fixture and view in the viewer, timed, and checks determinism',
  async () => {
    const s = await session();
    const bundles = new Map<string, { bytes: Uint8Array; bodies: number; ms: number }>();
    for (const name of [...FIXTURE_NAMES, ...STRESS_NAMES]) {
      const result = await regen(s, DOCUMENTS[name]());
      const scene = sceneOf(result, s.memberMeshes);
      const [bytes, ms] = await timed(() => bundleOf(name, result, scene));
      bundles.set(name, { bytes, bodies: scene.meshes.length, ms });
    }
    const launches: { launchMs: number; shots: Record<string, unknown>[] }[] = [];
    const hashesByLaunch: Record<string, string>[] = [];
    let withinLaunchIdentical = true;
    for (let l = 0; l < 2; l++) {
      const b = await launch();
      const shots: Record<string, unknown>[] = [];
      const hashes: Record<string, string> = {};
      for (const [name, bundle] of bundles) {
        const round1 = await viewerShots(b, bundle.bytes, bundle.bodies, [...VIEWS, ...VIEWS]);
        VIEWS.forEach((view, i) => {
          const first = round1[i]!;
          const second = round1[i + VIEWS.length]!;
          const same = sha(first.png) === sha(second.png);
          withinLaunchIdentical &&= same;
          hashes[`${name}/${view}`] = sha(first.png);
          shots.push({
            fixture: name,
            view,
            loadMs: round(first.ms.load),
            viewMs: round(median([first.ms.view, second.ms.view])),
            screenshotMs: round(median([first.ms.screenshot, second.ms.screenshot])),
            pngBytes: first.png.length,
            secondRoundIdentical: same,
          });
          if (l === 0) writeImage(SCRATCH, `chromium-${name}-${view}.png`, first.png);
        });
      }
      await b.browser.close();
      launches.push({ launchMs: round(b.launchMs), shots });
      hashesByLaunch.push(hashes);
    }
    const keys = Object.keys(hashesByLaunch[0]!);
    const acrossLaunches = keys.filter((k) => hashesByLaunch[0]![k] !== hashesByLaunch[1]![k]);

    const hashFile = join(RESULTS, 'chromium-hashes.json');
    const previous: Record<string, string> = existsSync(hashFile)
      ? (JSON.parse(readFileSync(hashFile, 'utf8')) as Record<string, string>)
      : {};
    const compared = keys.filter((k) => k in previous);
    const differing = compared.filter((k) => previous[k] !== hashesByLaunch[0]![k]);
    writeFileSync(hashFile, JSON.stringify(hashesByLaunch[0], null, 2) + '\n');

    // One sample for the write-up, as JPEG (the PNG is 200 to 400 KB: the grid is noisy).
    const sample = readFileSync(join(SCRATCH, 'chromium-shed-iso.png'));
    writeImage(
      IMAGES,
      'chromium-shed-iso.jpg',
      new Uint8Array(await sharp(sample).jpeg({ quality: 70 }).toBuffer()),
    );

    writeResult('chromium', {
      browser: 'Chrome Headless Shell 153.0.8010.12 (Playwright 1.63.0), SwiftShader WebGL',
      bundles: Object.fromEntries(
        [...bundles].map(([k, v]) => [
          k,
          { bytes: v.bytes.length, bodies: v.bodies, writeMs: round(v.ms) },
        ]),
      ),
      launches,
      determinism: {
        withinLaunchIdentical,
        acrossLaunchesDiffering: acrossLaunches,
        previousRunCompared: compared.length,
        previousRunDiffering: differing,
      },
    });
    console.log(JSON.stringify(launches, null, 1));
    console.log(
      'within',
      withinLaunchIdentical,
      'across',
      acrossLaunches,
      'previous',
      compared.length,
      differing,
    );
    await s.engine.dispose();
  },
);
