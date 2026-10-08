// Approach 3, the reference: the read-only viewer (viewer.html, T7.3b) in headless Chromium with
// SwiftShader WebGL, fed a `.mfkview` written by `packages/io` from the same regen result. The
// viewer is a test build (`VITE_E2E=1`, so `window.__manufakture.viewport` exists) made into a
// /tmp directory (README); pages and bundle are served through `page.route`, so no port is used.
//
// A `.mfkview` has bodies only. Framing members are baked into one body per member shape group
// here (each instance's triangles placed in world coordinates), which is what a publish of the
// shed would need too.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { writeMfkview, type MfkviewMesh } from '../../../packages/io/src/mfkview.ts';
import type { RegenResult } from '../../../packages/regen/src/index.ts';
import { creaseEdges, type Scene } from './fixtures';

export const VIEWER_DIR = process.env.T80B_VIEWER ?? '/tmp/t80b-viewer';
export const CHROME_LIBS = process.env.T80B_CHROME_LIBS ?? '/tmp/chromelibs';

type Playwright = typeof import('playwright-core');
// The app's own Playwright (apps/web devDependency), resolved from its real directory so that its
// sibling playwright-core is found.
const require = createRequire(
  realpathSync(
    join(import.meta.dirname, '../../../apps/web/node_modules/@playwright/test/package.json'),
  ),
);
export const playwright: Playwright = require('playwright-core');

const ORIGIN = 'https://viewer.spike';
const BUNDLE = 'https://bundle.spike/model.mfkview';
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** A body mesh from regen (names resolved), as the bundle wants it. */
function bodyMesh(
  result: RegenResult,
  mesh: NonNullable<RegenResult['parts'][0]['bodies'][0]['mesh']>,
): MfkviewMesh {
  const name = (i: number) => result.names[i] ?? null;
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    faceRanges: mesh.faceRanges,
    edgePositions: mesh.edgePositions,
    edgeRanges: mesh.edgeRanges,
    faceNames: Array.from(mesh.faceNames, name),
    edgeNames: Array.from(mesh.edgeNames, name),
  };
}

/** Every instance of a member mesh, placed: one face per member. */
function bakedMembers(m: Scene['meshes'][0]): MfkviewMesh {
  const count = m.matrices!.length / 16;
  const nv = m.positions.length / 3;
  const ni = m.indices.length;
  const positions = new Float32Array(3 * nv * count);
  const normals = new Float32Array(3 * nv * count);
  const indices = new Uint32Array(ni * count);
  const faceRanges = new Uint32Array(2 * count);
  const crease = creaseEdges(m.positions, m.indices);
  const ne = crease.edgePositions.length / 3;
  const edgePositions = new Float32Array(3 * ne * count);
  const edgeRanges = new Uint32Array(crease.edgeRanges.length * count);
  const M = m.matrices!;
  for (let i = 0; i < count; i++) {
    const b = 16 * i;
    const place = (src: Float32Array, dst: Float32Array, at: number, translate: boolean) => {
      for (let v = 0; v < src.length; v += 3) {
        const x = src[v]!,
          y = src[v + 1]!,
          z = src[v + 2]!;
        const t = translate ? 1 : 0;
        dst[at + v] = M[b]! * x + M[b + 4]! * y + M[b + 8]! * z + t * M[b + 12]!;
        dst[at + v + 1] = M[b + 1]! * x + M[b + 5]! * y + M[b + 9]! * z + t * M[b + 13]!;
        dst[at + v + 2] = M[b + 2]! * x + M[b + 6]! * y + M[b + 10]! * z + t * M[b + 14]!;
      }
    };
    place(m.positions, positions, 3 * nv * i, true);
    place(m.normals, normals, 3 * nv * i, false);
    place(crease.edgePositions, edgePositions, 3 * ne * i, true);
    for (let k = 0; k < ni; k++) indices[ni * i + k] = m.indices[k]! + nv * i;
    faceRanges[2 * i] = ni * i;
    faceRanges[2 * i + 1] = ni;
    const er = crease.edgeRanges;
    for (let k = 0; k < er.length; k += 2) {
      edgeRanges[er.length * i + k] = er[k]! + ne * i;
      edgeRanges[er.length * i + k + 1] = er[k + 1]!;
    }
  }
  return {
    positions,
    normals,
    indices,
    faceRanges,
    edgePositions,
    edgeRanges,
    faceNames: m.names.map(() => null),
    edgeNames: Array.from({ length: edgeRanges.length / 2 }, () => null),
  };
}

/** The scene as a `.mfkview` bundle: the bodies, then one baked body per member shape group. */
export async function bundleOf(
  name: string,
  result: RegenResult,
  scene: Scene,
): Promise<Uint8Array> {
  const meshes = new Map(
    result.parts.flatMap((p) => p.bodies).map((b) => [b.bodyId, b.mesh] as const),
  );
  const hex = (c: readonly number[]) =>
    `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const bodies = scene.meshes.map((m, i) => ({
    name: m.kind === 'body' ? m.key : `members ${i}`,
    color: hex(m.colors[0]!),
    material: null,
    volume: null,
    mass: null,
    mesh: m.kind === 'body' ? bodyMesh(result, meshes.get(m.key)!) : bakedMembers(m),
  }));
  return writeMfkview({
    name,
    kind: 'part',
    bodies,
    parts: [{ name, bodies: bodies.map((_, i) => i) }],
    instances: [{ name, part: 0, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
  });
}

export interface Browser {
  browser: import('playwright-core').Browser;
  launchMs: number;
}

export async function launch(): Promise<Browser> {
  const libs = join(CHROME_LIBS, 'usr/lib');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (existsSync(libs)) env.LD_LIBRARY_PATH = libs;
  if (existsSync(join(CHROME_LIBS, 'fonts.conf')))
    env.FONTCONFIG_FILE = join(CHROME_LIBS, 'fonts.conf');
  const t0 = performance.now();
  const browser = await playwright.chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    env,
  });
  return { browser, launchMs: performance.now() - t0 };
}

export interface Shot {
  png: Uint8Array;
  ms: { load: number; view: number; screenshot: number };
}

/**
 * Open the viewer on `bundle`, frame each of `views` (the viewer's standard views) without
 * animation, and screenshot the canvas pinned at 1024 x 768. `load` is page open to the bodies
 * shown; `view` the view change to a settled frame.
 */
export async function viewerShots(
  b: Browser,
  bundle: Uint8Array,
  bodies: number,
  views: readonly string[],
): Promise<Shot[]> {
  const context = await b.browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    bypassCSP: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(VIEWER_DIR, path === '/' ? 'viewer.html' : path);
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    await route.fulfill({
      status: 200,
      body: readFileSync(file),
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
    });
  });
  await page.route(BUNDLE, (route) =>
    route.fulfill({
      status: 200,
      body: Buffer.from(bundle),
      headers: {
        'content-type': 'application/vnd.manufakture.view+zip',
        'access-control-allow-origin': '*',
      },
    }),
  );
  let t0 = performance.now();
  await page.goto(`${ORIGIN}/viewer.html#src=${BUNDLE}`);
  await page.addStyleTag({
    content:
      '.viewport-canvas { position: fixed !important; left: 0 !important; top: 0 !important; ' +
      'width: 1024px !important; height: 768px !important; z-index: 1000; }',
  });
  await page.waitForFunction(
    (n) => {
      const v = (
        window as unknown as { __manufakture?: { viewport: { info(): { bodies: unknown[] } } } }
      ).__manufakture?.viewport;
      return (v?.info().bodies.length ?? 0) === n;
    },
    bodies,
    { timeout: 120_000 },
  );
  const load = performance.now() - t0;
  const shots: Shot[] = [];
  for (const view of views) {
    t0 = performance.now();
    await page.evaluate(async (name) => {
      const v = (
        window as unknown as {
          __manufakture: {
            viewport: {
              setStandardView(n: string, a: boolean): void;
              info(): { animating: boolean; size: { width: number } };
            };
          };
        }
      ).__manufakture.viewport;
      v.setStandardView(name, false);
      // Three frames, so a resize and the redraw it causes have both landed.
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    }, view);
    const viewMs = performance.now() - t0;
    t0 = performance.now();
    const png = await page.locator('[data-testid="viewer-canvas"]').screenshot();
    shots.push({
      png: new Uint8Array(png),
      ms: { load, view: viewMs, screenshot: performance.now() - t0 },
    });
  }
  await context.close();
  if (errors.length) throw new Error(errors.join('\n'));
  return shots;
}
