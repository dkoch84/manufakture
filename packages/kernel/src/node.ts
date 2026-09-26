// Node harness: the kernel without a browser, for tests and golden files
// (ADR 0007: every request and reply is plain data, so workers are testable in
// Node). Reads the pinned .wasm from node_modules and compiles it once per
// process; every kernel or service made here shares that module.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Kernel, type KernelOptions } from './kernel';
import { OcctLoader, type LoaderOptions } from './loader';
import type { Oc } from './occt';
import { KernelService, type KernelServiceOptions } from './service';

let shared: OcctLoader | null = null;

/** Absolute path of libcascade's single-threaded .wasm. */
export function wasmPath(): string {
  return createRequire(import.meta.url).resolve('libcascade/single/wasm');
}

/** A loader for the pinned .wasm read from disk. Pass options for a private one. */
export async function nodeLoader(options?: LoaderOptions): Promise<OcctLoader> {
  if (options === undefined && shared !== null) return shared;
  const loader = new OcctLoader({ bytes: await readFile(wasmPath()) }, options);
  if (options === undefined) shared = loader;
  return loader;
}

/** A fresh libcascade instance. */
export async function createNodeInstance(): Promise<Oc> {
  return (await nodeLoader()).instantiate();
}

/** A synchronous kernel on a fresh instance. */
export async function createNodeKernel(options?: KernelOptions): Promise<Kernel> {
  return new Kernel(await createNodeInstance(), options);
}

/** A kernel service whose recycles make new instances from the shared module. */
export async function createNodeService(
  options: Omit<KernelServiceOptions, 'createInstance'> = {},
): Promise<KernelService> {
  const loader = await nodeLoader();
  return KernelService.create({ ...options, createInstance: () => loader.instantiate() });
}
