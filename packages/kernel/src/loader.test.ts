// The loader's browser path (fetch, streaming compile, progress) run in Node
// against the real .wasm, served from memory.

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { LIBCASCADE_WASM_BYTES, OcctLoader, type LoadProgress } from './loader';
import { wasmPath } from './node';

let bytes: Uint8Array;

beforeAll(async () => {
  bytes = new Uint8Array(await readFile(wasmPath()));
}, 60_000);

/** A response that streams `bytes` in chunks, like a network would. */
function streamed(headers: Record<string, string>, status = 200, chunk = 1 << 20): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(body, { status, headers });
}

function recorder() {
  const events: LoadProgress[] = [];
  return { events, onProgress: (p: LoadProgress) => events.push(p) };
}

describe('OcctLoader', () => {
  it('is the pinned libcascade build', () => {
    expect(bytes.length).toBe(LIBCASCADE_WASM_BYTES);
  });

  it('streams a download with byte progress, then compiles', async () => {
    const { events, onProgress } = recorder();
    const urls: string[] = [];
    const loader = new OcctLoader(
      {
        url: '/assets/opencascade_single-abc123.wasm',
        fetch: async (url) => {
          urls.push(String(url));
          return streamed({
            'Content-Type': 'application/wasm',
            'Content-Length': String(bytes.length),
          });
        },
      },
      { onProgress, progressIntervalMs: 0 },
    );
    const module = await loader.compile();
    expect(module).toBeInstanceOf(WebAssembly.Module);
    expect(urls).toEqual(['/assets/opencascade_single-abc123.wasm']);
    // Cached: a second compile (a recycle) does not fetch again.
    expect(await loader.compile()).toBe(module);
    expect(urls).toHaveLength(1);

    const downloads = events.filter((e) => e.phase === 'download');
    expect(downloads.length).toBeGreaterThan(10); // one per 1 MiB chunk, plus start and end
    expect(downloads[0]).toEqual({ phase: 'download', loaded: 0, total: bytes.length });
    expect(downloads.at(-1)).toEqual({
      phase: 'download',
      loaded: bytes.length,
      total: bytes.length,
    });
    for (let i = 1; i < downloads.length; i++) {
      const [a, b] = [downloads[i - 1]!, downloads[i]!];
      if (a.phase === 'download' && b.phase === 'download')
        expect(b.loaded).toBeGreaterThanOrEqual(a.loaded);
    }
    expect(events.at(-1)).toEqual({ phase: 'compile' });
  });

  it('uses the known size as total when the response is compressed', async () => {
    const { events, onProgress } = recorder();
    const loader = new OcctLoader(
      {
        url: 'x.wasm',
        fetch: async () => streamed({ 'Content-Encoding': 'br', 'Content-Length': '8223986' }),
      },
      { onProgress, progressIntervalMs: 1e9, expectedBytes: 123 },
    );
    await loader.compile();
    const downloads = events.filter((e) => e.phase === 'download');
    // Throttled: the first chunk, and the final count.
    expect(downloads[0]).toEqual({ phase: 'download', loaded: 0, total: 123 });
    // More bytes than expected: the total is unknown rather than wrong.
    expect(downloads.slice(1, -1).every((d) => d.phase === 'download' && d.total === null)).toBe(
      true,
    );
    expect(downloads.at(-1)).toEqual({
      phase: 'download',
      loaded: bytes.length,
      total: bytes.length,
    });
    expect(downloads.length).toBeLessThanOrEqual(3);
  });

  it('a failed download rejects, and the next attempt fetches again', async () => {
    let calls = 0;
    const loader = new OcctLoader({
      url: 'missing.wasm',
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response('not found', { status: 404 }) : streamed({});
      },
    });
    await expect(loader.compile()).rejects.toThrow(/HTTP 404 for missing.wasm/);
    await expect(loader.compile()).resolves.toBeInstanceOf(WebAssembly.Module);
    expect(calls).toBe(2);
  });

  it('bytes and modules skip the download', async () => {
    const { events, onProgress } = recorder();
    const fromBytes = new OcctLoader({ bytes }, { onProgress });
    const module = await fromBytes.compile();
    expect(events).toEqual([{ phase: 'compile' }]);
    const fromModule = new OcctLoader({ module });
    expect(await fromModule.compile()).toBe(module);
  });

  it('instantiates a working kernel, reporting every phase up to ready', async () => {
    const { events, onProgress } = recorder();
    const loader = new OcctLoader({ bytes }, { onProgress });
    const oc = await loader.instantiate();
    expect(typeof oc.BRepPrimAPI_MakeBox).toBe('function');
    expect(events.map((e) => e.phase)).toEqual(['compile', 'instantiate', 'init', 'ready']);
    const ready = events.at(-1)!;
    expect(ready.phase === 'ready' && ready.ms > 0).toBe(true);
  }, 60_000);

  it('a module that cannot be instantiated rejects instead of hanging', async () => {
    // A valid module with an import the glue does not provide.
    const wat = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02,
      0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6e, 0x6f, 0x70, 0x00, 0x00,
    ]);
    const loader = new OcctLoader({ module: await WebAssembly.compile(wat) });
    await expect(loader.instantiate()).rejects.toThrow();
  }, 60_000);
});
