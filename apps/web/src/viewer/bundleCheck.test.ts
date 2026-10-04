import { describe, expect, it } from 'vitest';
import {
  VIEWER_JS_BUDGET_GZIP,
  checkViewerBundle,
  forbiddenReason,
  reachableChunks,
  type BuiltChunk,
} from './bundleCheck';

const ROOT = '/repo/apps/web';
const PNPM = '/repo/node_modules/.pnpm';

function chunk(fileName: string, modules: string[], more: Partial<BuiltChunk> = {}): BuiltChunk {
  return {
    fileName,
    facadeModuleId: null,
    imports: [],
    dynamicImports: [],
    modules,
    rawBytes: 1000,
    gzipBytes: 300,
    ...more,
  };
}

describe('forbiddenReason', () => {
  it('allows the viewer, the viewport, the view stores and its packages', () => {
    for (const id of [
      `${ROOT}/viewer.html`,
      `${ROOT}/src/viewer/ViewerApp.tsx`,
      `${ROOT}/src/viewport/engine.ts`,
      `${ROOT}/src/state/selection.ts`,
      `${ROOT}/src/state/viewSettings.ts`,
      `${ROOT}/src/measure/format.ts`,
      '/repo/packages/io/src/mfkview.ts',
      '/repo/packages/io/src/zip.ts',
      '/repo/packages/units/src/format.ts',
      '/repo/packages/kernel/src/types.ts',
      '/repo/packages/kernel/src/names.ts',
      `${PNPM}/three@0.186.1/node_modules/three/build/three.core.js`,
      `${PNPM}/react-dom@19.3.0_react@19.3.0/node_modules/react-dom/client.js`,
      `${PNPM}/zustand@5.0.15/node_modules/zustand/esm/vanilla.mjs`,
      '\0vite/preload-helper.js',
      'vite/modulepreload-polyfill.js',
      'rolldown/runtime.js',
    ]) {
      expect(forbiddenReason(id, ROOT), id).toBeNull();
    }
  });

  it('refuses the kernel, the solver, regen, core and editor code', () => {
    const cases: [string, RegExp][] = [
      ['/repo/packages/kernel/src/kernel.ts', /@manufakture\/kernel/],
      ['/repo/packages/kernel/src/index.ts', /@manufakture\/kernel/],
      ['/repo/packages/regen/src/index.ts', /@manufakture\/regen/],
      ['/repo/packages/sketch/src/solver.ts', /@manufakture\/sketch/],
      ['/repo/packages/core/src/commands.ts', /@manufakture\/core/],
      ['/repo/packages/io/src/index.ts', /@manufakture\/io/],
      ['/repo/packages/io/src/svg-import.ts', /@manufakture\/io/],
      [`${PNPM}/libcascade@3.0.2/node_modules/libcascade/dist/init.single.js`, /libcascade/],
      [
        `${PNPM}/@salusoft89+planegcs@1.2.0/node_modules/@salusoft89/planegcs/dist/x.js`,
        /planegcs/,
      ],
      [`${PNPM}/manifold-3d@3.5.4/node_modules/manifold-3d/manifold.js`, /manifold-3d/],
      [`${ROOT}/src/App.tsx`, /editor code/],
      [`${ROOT}/src/state/document.ts`, /editor code/],
      [`${ROOT}/src/sketcher/useSketching.ts`, /editor code/],
      ['/elsewhere/file.js', /outside/],
    ];
    for (const [id, reason] of cases) expect(forbiddenReason(id, ROOT), id).toMatch(reason);
  });

  it('reads Windows paths too', () => {
    expect(forbiddenReason('C:\\repo\\apps\\web\\src\\App.tsx', 'C:\\repo\\apps\\web')).toBeNull();
  });
});

describe('checkViewerBundle', () => {
  const viewerEntry = chunk(
    'assets/viewer-AAAA.js',
    [`${ROOT}/viewer.html`, `${ROOT}/src/viewer/main.tsx`],
    {
      facadeModuleId: `${ROOT}/viewer.html`,
      imports: ['assets/three-BBBB.js'],
      dynamicImports: ['assets/lazy-CCCC.js'],
    },
  );
  const three = chunk(
    'assets/three-BBBB.js',
    [`${PNPM}/three@0.186.1/node_modules/three/build/three.module.js`],
    {
      gzipBytes: 100_000,
    },
  );
  const app = chunk('assets/main-DDDD.js', [`${ROOT}/src/App.tsx`], {
    facadeModuleId: `${ROOT}/index.html`,
  });

  it('is null for a build without the viewer', () => {
    expect(checkViewerBundle([app], ROOT)).toBeNull();
  });

  it('follows static and dynamic imports and sums only the viewer chunks', () => {
    const lazy = chunk('assets/lazy-CCCC.js', [`${ROOT}/src/viewer/scene.ts`]);
    const report = checkViewerBundle([viewerEntry, three, lazy, app], ROOT)!;
    expect(report.files).toEqual([
      'assets/viewer-AAAA.js',
      'assets/three-BBBB.js',
      'assets/lazy-CCCC.js',
    ]);
    expect(report.gzipBytes).toBe(100_600);
    expect(report.problems).toEqual([]);
    expect(reachableChunks([viewerEntry, three, lazy, app], viewerEntry)).toHaveLength(3);
  });

  it('names a forbidden module even behind a dynamic import', () => {
    const lazy = chunk('assets/lazy-CCCC.js', ['/repo/packages/kernel/src/kernel.ts']);
    const report = checkViewerBundle([viewerEntry, three, lazy], ROOT)!;
    expect(report.forbidden.map((f) => f.id)).toEqual(['/repo/packages/kernel/src/kernel.ts']);
    expect(report.problems[0]).toMatch(/^viewer: module kernel\/src\/kernel\.ts/);
  });

  it('fails over the budget', () => {
    const lazy = chunk('assets/lazy-CCCC.js', [], { gzipBytes: VIEWER_JS_BUDGET_GZIP });
    const report = checkViewerBundle([viewerEntry, three, lazy], ROOT)!;
    expect(report.problems).toEqual([expect.stringMatching(/over the 340\.0 KiB budget/)]);
  });
});
