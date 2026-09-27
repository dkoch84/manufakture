import { configDefaults, defineConfig } from 'vitest/config';

// A NODE_ENV=production inherited from the shell would load React's production
// build (no act()) and break component tests. Tests always run as "test".
process.env.NODE_ENV = 'test';

// The kernel's golden tests (volume, face count and bounding box per feature, exact measures,
// STEP round trips, the M1 bracket) are their own project, so CI runs them as one job:
// `vitest run --project kernel-goldens`. A plain `vitest run` still runs every project.
const KERNEL_GOLDENS = [
  'packages/kernel/src/features.test.ts',
  'packages/kernel/src/measure.test.ts',
  'packages/kernel/src/exchange.test.ts',
  'packages/kernel/test/**/*.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...KERNEL_GOLDENS],
        },
      },
      {
        test: {
          name: 'kernel-goldens',
          environment: 'node',
          include: KERNEL_GOLDENS,
        },
      },
      'apps/web',
    ],
  },
});
