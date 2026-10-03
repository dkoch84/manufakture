import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { settle } from './helpers';
import { execute } from './m2-fixtures';
import {
  HOUSE,
  HOUSE_IDS,
  HOUSE_LAYERS,
  MOVED_POSITION_IN,
  houseBatch,
  moveWindow,
} from './m6-fixtures';

// T6.5d in Chromium: the 2,000 sq ft house of m6-fixtures.ts (the domain's
// src/fixtures/house.ts) built through the app's store, regenerated in the app's regen worker and
// drawn by the viewport, against the budgets of the T6.5a spike (docs/spikes/T6.5a-framing.md,
// "4. Budgets for T6.5d"). The Node side (framing and regen medians, the heap probe) is the
// domain's bench, packages/domain-construction/bench.
//
// - First render: from the batch that adds the house to the model shown and every member and
//   layer body in the viewport (regen, transfer, viewport update).
// - Warm: moving the south wall's window, five positions never seen before: the worker's regen
//   time and the round trip to the viewport.
// - Draw calls: WebGL draw calls per frame with every member and body shown, counted by wrapping
//   the context's draw functions (an init script), over the frames `measureFrames` renders.
// - Frame time: `measureFrames` orbiting the whole house. Headless Chromium renders with
//   SwiftShader (software GL on the CPU), so these are CPU rasterizer times, not GPU times: a CI
//   regression check, not a performance target. The 60 fps target on a mid-range laptop GPU is
//   not measurable here.
// - Pick latency: `pickAt` over a grid of canvas points with the layers hidden, so members are hit.
//
// The numbers go to the console, a JSON attachment, test-results/perf-house.json and the GitHub job
// summary. Timing checks allow a margin over the budgets (CI_MARGIN, FRAME_MARGIN) so a noisy CI
// runner fails only on a large regression; draw calls are deterministic and checked as budgeted.

/** T6.5a's house budgets. */
const BUDGET = {
  /** Whole regen, cold, in the worker (the kernel instance start excluded: it is already up). */
  regenColdMs: 3_000,
  /** Whole regen, warm after moving one opening, in the worker. */
  regenWarmMs: 150,
  /** Draw calls with members shown. */
  drawCalls: 250,
  /**
   * Frame time, SwiftShader, 1280 x 800: the mean frame interval. Frames are paced by
   * `requestAnimationFrame` at 16.7 ms, so the median only says whether most frames fit in one
   * interval; the mean counts the frames that took two or more. (The spike timed each frame
   * with a `readPixels` instead, which the app's `measureFrames` does not do.)
   */
  frameMs: 30,
};
/** Regen times may be this many times their budget before the check fails (noisy CI runners). */
const CI_MARGIN = 5;
/**
 * Frame times may be this many times theirs: the spike's 21 ms came from a 6-core desktop CPU;
 * SwiftShader on a 2-core CI runner is several times slower, and frames are paced by
 * `requestAnimationFrame`.
 */
const FRAME_MARGIN = 4;

interface MemberStats {
  members: number;
  sets: number;
  shapes: number;
  drawCalls: number;
  triangles: number;
  edgesShown: number;
}

interface FrameStats {
  frames: number;
  triangles: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  renderCpuMs: number;
}

/** The hooks this spec uses beyond global.d.ts's. */
interface PerfHooks {
  viewport: {
    memberInfo(): MemberStats;
    setHiddenLayers(layers: string[]): void;
    pickAt(x: number, y: number): { kind: string; id: string } | null;
    measureFrames(frames?: number): Promise<FrameStats>;
    fitAll(animate?: boolean): void;
    setStandardView(view: string, animate?: boolean): void;
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Count WebGL draw calls on every context of the page, in `window.__drawCalls`. */
async function countDrawCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __drawCalls: number };
    w.__drawCalls = 0;
    for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
      const p = proto as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
        'drawRangeElements',
      ]) {
        const original = p[name];
        if (typeof original !== 'function') continue;
        p[name] = function (this: unknown, ...args: unknown[]) {
          w.__drawCalls++;
          return original.apply(this, args);
        };
      }
    }
  });
}

const drawCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __drawCalls: number }).__drawCalls);

/**
 * Run `command` and resolve to the milliseconds (page clock) until the model shows the new
 * document and the viewport has `members` members and `bodies` bodies.
 */
async function timed(page: Page, command: unknown, label: string): Promise<number> {
  const start = await page.evaluate(() => performance.now());
  await execute(page, command, label);
  const handle = await page.waitForFunction(
    ({ members, bodies }) => {
      const hooks = window.__manufakture!;
      const m = hooks.model.getState();
      const vp = hooks.viewport as unknown as PerfHooks['viewport'] & {
        info(): { bodies: unknown[] };
      };
      const shown =
        !m.pending &&
        m.document === hooks.document.getState().document &&
        vp.memberInfo().members === members &&
        vp.info().bodies.length === bodies;
      return shown ? performance.now() : 0;
    },
    { members: HOUSE.members, bodies: HOUSE.bodies },
    { timeout: 120_000, polling: 'raf' },
  );
  return ((await handle.jsonValue()) as number) - start;
}

const workerMs = (page: Page) => page.evaluate(() => window.__manufakture!.model.getState().ms);

test('the house regenerates, draws and picks within the T6.5a budgets', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await countDrawCalls(page);
  const errors = await openEmpty(page);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  // First render: the whole house, cold (the kernel is up; Manifold loads on the first cut member).
  const firstRenderMs = await timed(page, await houseBatch(page), 'House');
  const regenColdMs = await workerMs(page);
  const statuses = await regenerated(page);
  expect(Object.keys(statuses)).toHaveLength(HOUSE.features);
  for (const [id, s] of Object.entries(statuses)) {
    expect(s.status, `${id}: ${JSON.stringify(s.errors)}`).toBe('ok');
  }
  const members = await page.evaluate(() =>
    (window.__manufakture!.viewport as unknown as PerfHooks['viewport']).memberInfo(),
  );
  expect(members.members).toBe(HOUSE.members);
  expect(members.sets).toBe(HOUSE.groups);

  // Warm: the window moved to five positions never seen before (so nothing comes from the cache).
  const warm: { worker: number; roundTrip: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const at = MOVED_POSITION_IN + (i % 2 === 0 ? 12 : 0) + (i + 1) / 64;
    const roundTrip = await timed(page, await moveWindow(page, at), `Window ${i}`);
    const s = await regenerated(page);
    expect(s[HOUSE_IDS.moved]).toMatchObject({ status: 'ok', cached: false });
    expect(s[HOUSE_IDS.exterior[0]]!.cached).toBe(true);
    warm.push({ worker: await workerMs(page), roundTrip });
  }

  // The whole house in view, iso: draw calls and frame times while orbiting.
  await page.evaluate(() => {
    const v = window.__manufakture!.viewport as unknown as PerfHooks['viewport'];
    v.setStandardView('iso', false);
    v.fitAll(false);
  });
  await settle(page);
  const frames = 90;
  const callsBefore = await drawCalls(page);
  const frame = await page.evaluate(
    (n) => (window.__manufakture!.viewport as unknown as PerfHooks['viewport']).measureFrames(n),
    frames,
  );
  // measureFrames renders `frames + 1` times (the first frame starts the clock).
  const drawCallsPerFrame = ((await drawCalls(page)) - callsBefore) / (frames + 1);
  const memberDraw = await page.evaluate(() =>
    (window.__manufakture!.viewport as unknown as PerfHooks['viewport']).memberInfo(),
  );

  // Pick latency with every layer hidden, so members are under the cursor.
  await page.evaluate(
    (layers) =>
      (window.__manufakture!.viewport as unknown as PerfHooks['viewport']).setHiddenLayers(layers),
    HOUSE_LAYERS,
  );
  await settle(page);
  const picks = await page.evaluate(() => {
    const v = window.__manufakture!.viewport as unknown as PerfHooks['viewport'];
    const canvas = document.querySelector('[data-testid="viewport-canvas"]')!;
    const { width, height } = canvas.getBoundingClientRect();
    const out: { ms: number; kind: string | null; id: string | null }[] = [];
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 6; j++) {
        const t0 = performance.now();
        const hit = v.pickAt((width * i) / 8, (height * j) / 6);
        out.push({ ms: performance.now() - t0, kind: hit?.kind ?? null, id: hit?.id ?? null });
      }
    }
    return out;
  });
  const memberPicks = picks.filter((p) => p.kind === 'member');

  const measures = {
    firstRenderMs: r1(firstRenderMs),
    regenColdMs: r1(regenColdMs),
    regenWarmMs: r1(median(warm.map((w) => w.worker))),
    warmRoundTripMs: r1(median(warm.map((w) => w.roundTrip))),
    drawCalls: r1(drawCallsPerFrame),
    memberDrawCalls: memberDraw.drawCalls,
    frameMs: r1(frame.meanMs),
    frameP50Ms: r1(frame.p50Ms),
    frameP95Ms: r1(frame.p95Ms),
    renderCpuMs: r1(frame.renderCpuMs),
    triangles: frame.triangles,
    pickMs: r1(median(picks.map((p) => p.ms))),
    // The first pick compiles the pick pass's shaders.
    pickFirstMs: r1(picks[0]!.ms),
    pickMaxLaterMs: r1(Math.max(...picks.slice(1).map((p) => p.ms))),
    memberPicks: `${memberPicks.length} of ${picks.length}`,
  };
  const report = { renderer, members: memberDraw, measures, budgets: BUDGET, warm };
  console.log(`perf-house (${renderer}): ${JSON.stringify(measures)}`);
  await testInfo.attach('perf-house', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await mkdir(testInfo.project.outputDir, { recursive: true });
  await writeFile(
    join(testInfo.project.outputDir, 'perf-house.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await appendFile(
      summary,
      [
        `### M6 house (${HOUSE.members} members; headless Chromium, SwiftShader: software GL, not a GPU)`,
        '',
        '| Measure | Value | Budget (T6.5a) |',
        '| --- | ---: | ---: |',
        `| First render (regen, transfer, viewport) | ${measures.firstRenderMs} ms | |`,
        `| Whole regen, cold, worker | ${measures.regenColdMs} ms | ${BUDGET.regenColdMs} ms |`,
        `| Whole regen, warm, worker | ${measures.regenWarmMs} ms | ${BUDGET.regenWarmMs} ms |`,
        `| Warm round trip | ${measures.warmRoundTripMs} ms | |`,
        `| Draw calls per frame | ${measures.drawCalls} | ${BUDGET.drawCalls} |`,
        `| Frame time (SwiftShader, mean interval) | ${measures.frameMs} ms | ${BUDGET.frameMs} ms |`,
        `| Pick (SwiftShader, median) | ${measures.pickMs} ms | |`,
        '',
      ].join('\n'),
    );
  }

  // Instancing keeps draw calls far below one per member (the spike: 137 for its house).
  expect(measures.drawCalls, 'draw calls per frame').toBeLessThan(BUDGET.drawCalls);
  expect(memberDraw.drawCalls).toBeLessThan(HOUSE.members / 4);
  expect(memberPicks.length, 'some grid points pick a member').toBeGreaterThan(0);
  expect(frame.frames).toBe(frames);
  expect(measures.regenColdMs, 'whole regen, cold').toBeLessThan(BUDGET.regenColdMs * CI_MARGIN);
  expect(measures.regenWarmMs, 'whole regen, warm').toBeLessThan(BUDGET.regenWarmMs * CI_MARGIN);
  expect(measures.frameMs, 'frame time (SwiftShader)').toBeLessThan(BUDGET.frameMs * FRAME_MARGIN);
  expect(errors).toEqual([]);
});
