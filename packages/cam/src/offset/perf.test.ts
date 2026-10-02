import { describe, expect, it } from 'vitest';
import type { Loop2, Vec2 } from '../types';
import { offsetLoops } from './engine';
import { circle, hole, polygon, roundedRect, slot } from './test-shapes';

// Performance budget (M5 plan, T5.2a), an estimate: wall time in Node, offset plus refit, compared
// with the T5.0a spike's clipper2-ts medians (bracket 0.64 to 3.1 ms, a 10,000-vertex outline 35
// to 126 ms, 50 pocket rings 264 ms plus 11 ms of refit). Other tests run on the same machine, so
// the bounds are ten times the spike's figures: they catch a regression of an order of
// magnitude (offsetting each ring from the previous one was 41 times slower), not noise.

function median(run: () => void, n: number): number {
  run();
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[n >> 1]!;
}

const bracket: Loop2[] = [
  roundedRect(100, 60, 8),
  hole(circle([-35, 0], 6)),
  hole(circle([35, 0], 6)),
  hole(slot([0, 0], 20, 10)),
];

describe('performance budget (estimate)', () => {
  it('stays within ten times the spike', () => {
    const bracketMs = median(() => {
      offsetLoops(bracket, 3);
      offsetLoops(bracket, -3);
    }, 10);
    const flower: Vec2[] = [];
    for (let i = 0; i < 10000; i++) {
      const t = (i / 10000) * 2 * Math.PI;
      const r = 40 + 6 * Math.sin(9 * t);
      flower.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    const flowerMs = median(() => offsetLoops([polygon(flower)], 3), 3);
    const pocket = [roundedRect(200, 160, 20), hole(circle([30, 20], 12))];
    const ringsMs = median(() => {
      for (let k = 0; k < 50; k++) offsetLoops(pocket, -3 - 1.5 * k);
    }, 3);
    console.log(
      `offset + refit, median ms: bracket +-3 ${bracketMs.toFixed(1)}, ` +
        `flower-10k +3 ${flowerMs.toFixed(1)}, pocket 50 rings ${ringsMs.toFixed(1)}`,
    );
    expect(bracketMs).toBeLessThan(2 * 31);
    expect(flowerMs).toBeLessThan(1260);
    expect(ringsMs).toBeLessThan(2750);
  });
});
