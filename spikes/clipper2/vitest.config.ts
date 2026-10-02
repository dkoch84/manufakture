import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'spike-clipper2',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
