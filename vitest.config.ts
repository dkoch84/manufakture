import { defineConfig } from 'vitest/config';

// A NODE_ENV=production inherited from the shell would load React's production
// build (no act()) and break component tests. Tests always run as "test".
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      'apps/web',
    ],
  },
});
