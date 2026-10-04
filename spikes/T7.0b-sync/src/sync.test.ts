import { describe, expect, it } from 'vitest';
import { bracket } from './fixtures.ts';
import { SCENARIOS } from './scenarios.ts';
import { runScenario } from './sim.ts';

describe('sync spike', () => {
  for (const name of ['two-busy', 'five-busy', 'three-lossy', 'offline', 'restores']) {
    it(`${name} converges with valid documents and intact intent`, () => {
      const sc = { ...SCENARIOS.find((s) => s.name === name)!, commandsPerClient: 30 };
      const r = runScenario(sc, 1, bracket());
      expect(r.stuck).toBe(false);
      expect(r.violations).toEqual([]);
      expect(r.misbound).toEqual([]);
      expect(r.remapMisses).toBe(0);
      expect(r.accepted + r.dropped).toBe(r.generated);
      expect(r.converged).toBe(true);
    });
  }
});
