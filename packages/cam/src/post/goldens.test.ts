import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARBIDE_MOTION_GOLDEN_SUITE,
  GRBLHAL_GOLDEN_SUITE,
  LINUXCNC_GOLDEN_SUITE,
  MACH3_GOLDEN_SUITE,
  goldenDir,
  goldenPath,
  posted,
} from './golden-jobs';
import type { GoldenSuite } from './golden-jobs';

// The golden files of the posts T5.4c added (the grbl post's are in `grbl.test.ts`): each post
// writes the shared fixture jobs (`golden-jobs.ts`) byte for byte as `test/<post>/` holds them.
// The golden runner (`test/goldens.test.ts`) checks every file with `verifyGcode` for its dialect.
// After a deliberate change, rewrite them with `UPDATE_GOLDENS=1` and review the diff line by line.

const UPDATE = process.env.UPDATE_GOLDENS === '1';

function suite<O>(s: GoldenSuite<O>): void {
  describe(`${s.dir} post: golden files`, () => {
    for (const g of s.goldens) {
      it(`writes ${g.name} byte for byte`, () => {
        const out = posted(s.post, g.job, g.options);
        expect(out.files).toHaveLength(g.files);
        for (const f of out.files) {
          const path = goldenPath(s.dir, g.name, f.index, out.files.length);
          if (UPDATE) {
            mkdirSync(goldenDir(s.dir), { recursive: true });
            writeFileSync(path, f.text);
          }
          expect(existsSync(path), `${path} is missing: run with UPDATE_GOLDENS=1`).toBe(true);
          expect(f.text).toBe(readFileSync(path, 'utf8'));
        }
      });
    }
  });
}

suite(CARBIDE_MOTION_GOLDEN_SUITE);
suite(GRBLHAL_GOLDEN_SUITE);
suite(LINUXCNC_GOLDEN_SUITE);
suite(MACH3_GOLDEN_SUITE);
