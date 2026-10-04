// The four quickjs-emscripten 0.32.0 variants the spike compares: Bellard's QuickJS and the
// QuickJS-ng fork, each as the synchronous release build and the asyncified one. All four are
// "wasmfile" variants: the .wasm is a separate file, which the caller compiles once and hands in
// as a WebAssembly.Module, so a second instance never refetches or recompiles (ADR 0002's
// pattern for libcascade, ADR 0010 decision 4 for scripts).

import ngAsyncify from '@jitl/quickjs-ng-wasmfile-release-asyncify';
import ngSync from '@jitl/quickjs-ng-wasmfile-release-sync';
import quickjsAsyncify from '@jitl/quickjs-wasmfile-release-asyncify';
import quickjsSync from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

export const SYNC_VARIANTS = ['quickjs-sync', 'ng-sync'] as const;
export const ASYNC_VARIANTS = ['quickjs-asyncify', 'ng-asyncify'] as const;
export type SyncVariantName = (typeof SYNC_VARIANTS)[number];
export type AsyncVariantName = (typeof ASYNC_VARIANTS)[number];
export type VariantName = SyncVariantName | AsyncVariantName;
export const VARIANT_NAMES: readonly VariantName[] = [...SYNC_VARIANTS, ...ASYNC_VARIANTS];

/** npm package of each variant, for sizes and licenses. */
export const VARIANT_PACKAGES: Record<VariantName, string> = {
  'quickjs-sync': '@jitl/quickjs-wasmfile-release-sync',
  'ng-sync': '@jitl/quickjs-ng-wasmfile-release-sync',
  'quickjs-asyncify': '@jitl/quickjs-wasmfile-release-asyncify',
  'ng-asyncify': '@jitl/quickjs-ng-wasmfile-release-asyncify',
};

const syncVariants = { 'quickjs-sync': quickjsSync, 'ng-sync': ngSync };
const asyncVariants = { 'quickjs-asyncify': quickjsAsyncify, 'ng-asyncify': ngAsyncify };

export function isAsyncVariant(name: VariantName): name is AsyncVariantName {
  return (ASYNC_VARIANTS as readonly string[]).includes(name);
}

/**
 * The variants' memory: an imported `WebAssembly.Memory` of 256 pages (16 MiB) that may grow to
 * 32768 pages (2 GiB), not shared (read from the .wasm import section). Passing our own lets the
 * spike read its size, and is what a host would do to watch an instance's footprint.
 */
export function newMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 256, maximum: 32768 });
}

/** One instance of a sync variant from an already compiled module. */
export function instantiateSync(
  name: SyncVariantName,
  wasmModule: WebAssembly.Module,
  wasmMemory: WebAssembly.Memory = newMemory(),
): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(
    newVariant(syncVariants[name], { wasmModule, wasmMemory }),
  );
}

/** One instance of an asyncified variant from an already compiled module. */
export function instantiateAsync(
  name: AsyncVariantName,
  wasmModule: WebAssembly.Module,
  wasmMemory: WebAssembly.Memory = newMemory(),
): Promise<QuickJSAsyncWASMModule> {
  return newQuickJSAsyncWASMModuleFromVariant(
    newVariant(asyncVariants[name], { wasmModule, wasmMemory }),
  );
}
