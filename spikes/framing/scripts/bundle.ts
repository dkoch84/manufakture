// Bundles for the measurements: the kernel child for Node (the kernel's sources need Vite's
// resolver), and the viewport page for Chromium. Output under dist/, which git ignores.

import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function bundleKernelChild(): Promise<string> {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: 'scripts/kernel-child.ts',
      outDir: 'dist/node',
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      rollupOptions: { external: [/^libcascade(\/.*)?$/, /^node:/] },
    },
    ssr: { noExternal: true, target: 'node' },
  });
  return `${root}dist/node/kernel-child.js`;
}

export async function bundleViewport(): Promise<string> {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    base: './',
    build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2000 },
  });
  return `${root}dist/web/`;
}
