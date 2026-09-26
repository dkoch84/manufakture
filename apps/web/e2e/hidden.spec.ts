import { expect, test } from '@playwright/test';
import { openScene, settle } from './helpers';

// Hidden edges and vertices must not be pickable through the part. The demo
// part (a filleted block with a hole) is the hard case: the tangent edge of a
// fillet can be hidden behind the fillet while the fillet face next to it is
// in plain view, so "one of its faces is visible" is not enough.
//
// The check is independent of the GPU pick pass: the viewport ray-casts each
// point on the CPU (`hiddenDepth`) to tell how far behind the visible surface
// it lies. For every edge segment midpoint and vertex hidden by more than
// 1 mm, even when moved 1.5 px on screen in any direction, and with no
// visible part of the same edge within the pick tolerance, picking at its
// screen position must not return it. The margin leaves out geometry just
// behind a curved silhouette, closer to it than a pixel: there the depth
// buffer cannot tell it from the silhouette, on screen or in the pick pass.

const TOLERANCE_PX = 6;
const HIDDEN_MM = 1;
const VISIBLE_MM = 0.2;
const MARGIN_PX = 1.5;

test('hidden edges and vertices of the demo part cannot be picked through it', async ({
  page,
}, testInfo) => {
  await openScene(page, '', 90_000);
  const report: Record<string, unknown> = {};
  let totalProbes = 0;
  for (const view of ['iso', 'front', 'right'] as const) {
    await page.evaluate((v) => window.__manufakture!.viewport.setStandardView(v, false), view);
    await settle(page);
    const result = await page.evaluate(
      ({ tolerance, hiddenMm, visibleMm, marginPx }) => {
        const vp = window.__manufakture!.viewport;
        const rect = document
          .querySelector('[data-testid="viewport-canvas"]')!
          .getBoundingClientRect();
        type P = [number, number, number];
        const screen = (p: P) => {
          const c = vp.projectToClient(p);
          return { x: c.x - rect.left, y: c.y - rect.top };
        };
        const inside = (s: { x: number; y: number }) =>
          s.x >= 0 && s.y >= 0 && s.x < rect.width && s.y < rect.height;
        const lerp = (a: P, b: P, t: number): P => [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];

        let probes = 0;
        const failures: string[] = [];
        for (const sample of vp.geometrySamples()) {
          // Densely sample the edge (about one point per pixel) to find its
          // visible parts, and take each segment midpoint as a probe.
          const dense: P[] = [];
          const mids: P[] = [];
          if (sample.kind === 'vertex') {
            dense.push(sample.points[0]!);
            mids.push(sample.points[0]!);
          } else {
            for (let i = 0; i + 1 < sample.points.length; i++) {
              const a = sample.points[i]!;
              const b = sample.points[i + 1]!;
              const sa = screen(a);
              const sb = screen(b);
              const n = Math.max(1, Math.ceil(Math.hypot(sb.x - sa.x, sb.y - sa.y)));
              for (let k = 0; k <= n; k++) dense.push(lerp(a, b, k / n));
              mids.push(lerp(a, b, 0.5));
            }
          }
          const denseDepth = vp.hiddenDepth(dense);
          const visible = dense.filter((_, i) => denseDepth[i]! < visibleMm).map((p) => screen(p));
          const midDepth = vp.hiddenDepth(mids, marginPx);
          mids.forEach((mid, i) => {
            const depth = midDepth[i]!;
            if (!(depth > hiddenMm) || !Number.isFinite(depth)) return;
            const s = screen(mid);
            if (!inside(s)) return;
            // A visible part of the same edge within reach may rightly be picked.
            if (visible.some((v) => Math.hypot(v.x - s.x, v.y - s.y) <= tolerance + 1.5)) return;
            probes++;
            const hit = vp.pickAt(s.x, s.y);
            if (hit && hit.kind === sample.kind && hit.name === sample.name) {
              failures.push(`${sample.kind} ${sample.name} hidden by ${depth.toFixed(2)} mm`);
            }
          });
        }
        return { probes, failures };
      },
      { tolerance: TOLERANCE_PX, hiddenMm: HIDDEN_MM, visibleMm: VISIBLE_MM, marginPx: MARGIN_PX },
    );
    report[view] = result;
    totalProbes += result.probes;
    expect(result.failures, `picked through the part in the ${view} view`).toEqual([]);
  }
  await testInfo.attach('hidden-pick-probes', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`hidden pick probes: ${JSON.stringify(report)}`);
  // The check means something only if there were hidden edges to try.
  expect(totalProbes).toBeGreaterThan(50);
});
