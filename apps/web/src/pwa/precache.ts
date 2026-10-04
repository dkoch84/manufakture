// Which build files the service worker precaches, applied to Workbox's manifest at build time
// (vite.config.ts, `manifestTransforms`). Pure, so it is unit tested (precache.test.ts).
//
// Workbox's own size limit (`maximumFileSizeToCacheInBytes`) is one number for every file. The
// kernel's .wasm is about 42.7 MB raw, so the limit is lifted in the config and applied here
// instead: files up to `PRECACHE_SIZE_LIMIT`, plus the kernel by name. Files that only one rarely
// used feature loads (IFC export's web-ifc) are left out on purpose and cached by the worker on
// first use (policy.ts, `isRuntimeCacheable`), as the M7 plan says for QuickJS.

/** Workbox's default limit, kept for every file but the kernel. */
export const PRECACHE_SIZE_LIMIT = 2 * 1024 * 1024;

/** The kernel's .wasm (libcascade's single-threaded build, ADR 0002), at any hash. */
export const KERNEL_WASM = /(^|\/)opencascade_single-[A-Za-z0-9_-]{8}\.wasm$/;

/** Lazily loaded files that are cached on first use instead of precached. */
export const RUNTIME_ONLY = [/(^|\/)web-ifc(-api)?-[A-Za-z0-9_-]{8}\.(js|wasm)$/];

export interface ManifestEntry {
  url: string;
  revision: string | null;
  size: number;
}

/** A precache entry as the worker sees it: Workbox's fields plus the size for progress. */
export interface PrecacheEntryWithBytes {
  url: string;
  revision: string | null;
  bytes: number;
}

export interface PrecacheChoice {
  manifest: PrecacheEntryWithBytes[];
  warnings: string[];
}

/** Keep what fits the rules above; say what was left out and why. */
export function choosePrecache(entries: readonly ManifestEntry[]): PrecacheChoice {
  const manifest: PrecacheEntryWithBytes[] = [];
  const warnings: string[] = [];
  for (const e of entries) {
    if (RUNTIME_ONLY.some((re) => re.test(e.url))) continue;
    if (e.size > PRECACHE_SIZE_LIMIT && !KERNEL_WASM.test(e.url)) {
      warnings.push(
        `${e.url} (${e.size} bytes) is above the ${PRECACHE_SIZE_LIMIT}-byte precache limit and is ` +
          'cached on first use instead; add it to precache.ts if it must work offline from the start.',
      );
      continue;
    }
    // Workbox deletes `size` after the transforms run, so the size travels as `bytes`.
    manifest.push({ url: e.url, revision: e.revision, bytes: e.size });
  }
  if (!entries.some((e) => KERNEL_WASM.test(e.url))) {
    warnings.push('The kernel .wasm was not found among the build files; it is not precached.');
  }
  return { manifest, warnings };
}
