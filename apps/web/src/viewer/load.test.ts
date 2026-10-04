import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { boxBundle } from './bundles.test-fixture';
import {
  MAX_BUNDLE_BYTES,
  MAX_SOURCE_URL_LENGTH,
  ViewerLoadError,
  checkSourceUrl,
  fetchBundle,
  loadErrorMessage,
  openBundle,
  readBundleFile,
  rulesFor,
  sourceFromHash,
} from './load';

const PUBLIC = { allowLocalHttp: false };
const LOCAL = { allowLocalHttp: true };

describe('sourceFromHash', () => {
  it('takes everything after src=, query and ampersands included', () => {
    expect(sourceFromHash('#src=https://example.com/a.mfkview')).toBe(
      'https://example.com/a.mfkview',
    );
    expect(sourceFromHash('#src=https://example.com/get?id=1&sig=a+b')).toBe(
      'https://example.com/get?id=1&sig=a+b',
    );
    expect(sourceFromHash('src=https://example.com/x')).toBe('https://example.com/x');
  });

  it('decodes an address that was percent-encoded whole', () => {
    expect(sourceFromHash('#src=https%3A%2F%2Fexample.com%2Fa%20b.mfkview')).toBe(
      'https://example.com/a b.mfkview',
    );
    // A broken escape is left for the URL check to refuse.
    expect(sourceFromHash('#src=https%3A%E0%A4%A')).toBe('https%3A%E0%A4%A');
  });

  it('is null without a source', () => {
    expect(sourceFromHash('')).toBeNull();
    expect(sourceFromHash('#')).toBeNull();
    expect(sourceFromHash('#src=')).toBeNull();
    expect(sourceFromHash('#other=https://example.com/x')).toBeNull();
  });
});

describe('checkSourceUrl', () => {
  it('accepts https addresses', () => {
    expect(checkSourceUrl('https://example.com/a.mfkview', PUBLIC).href).toBe(
      'https://example.com/a.mfkview',
    );
  });

  it('refuses every other scheme', () => {
    for (const raw of [
      'http://example.com/a.mfkview',
      'javascript:alert(1)',
      'data:application/zip;base64,UEsFBg==',
      'blob:https://example.com/1',
      'file:///etc/passwd',
      'ftp://example.com/a',
    ]) {
      expect(() => checkSourceUrl(raw, PUBLIC), raw).toThrow(/must start with https/);
    }
  });

  it('accepts http only for localhost, and only when the viewer runs there', () => {
    expect(checkSourceUrl('http://localhost:4421/a.mfkview', LOCAL).port).toBe('4421');
    expect(checkSourceUrl('http://127.0.0.1/a', LOCAL).hostname).toBe('127.0.0.1');
    expect(() => checkSourceUrl('http://localhost:4421/a.mfkview', PUBLIC)).toThrow(
      ViewerLoadError,
    );
    expect(() => checkSourceUrl('http://example.com/a', LOCAL)).toThrow(ViewerLoadError);
    expect(rulesFor({ hostname: 'localhost' })).toEqual(LOCAL);
    expect(rulesFor({ hostname: '[::1]' })).toEqual(LOCAL);
    expect(rulesFor({ hostname: 'view.example.com' })).toEqual(PUBLIC);
  });

  it('refuses relative, credentialed and over-long addresses', () => {
    expect(() => checkSourceUrl('/shares/abc', PUBLIC)).toThrow(/full https/);
    expect(() => checkSourceUrl('https://user:pw@example.com/a', PUBLIC)).toThrow(/user name/);
    expect(() => checkSourceUrl('https://user@example.com/a', PUBLIC)).toThrow(/user name/);
    const long = `https://example.com/${'a'.repeat(MAX_SOURCE_URL_LENGTH)}`;
    expect(() => checkSourceUrl(long, PUBLIC)).toThrow(/longer than/);
  });
});

/** A fetch answering with `body` in chunks; `init` sets status, headers and the final URL. */
function fakeFetch(
  chunks: Uint8Array[],
  init: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    url?: string;
  } = {},
) {
  const cancel = vi.fn();
  const fn = vi.fn<typeof fetch>(async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
      cancel,
    });
    const response = new Response(body, {
      status: init.status ?? 200,
      statusText: init.statusText ?? '',
      headers: init.headers ?? {},
    });
    if (init.url !== undefined) Object.defineProperty(response, 'url', { value: init.url });
    return response;
  });
  return { fn, cancel };
}

const URL_A = new URL('https://example.com/a.mfkview');

describe('fetchBundle', () => {
  it('reads the body in chunks and sends no credentials or referrer', async () => {
    const { fn } = fakeFetch([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const progress = vi.fn();
    const bytes = await fetchBundle(URL_A, { rules: PUBLIC, fetch: fn, onProgress: progress });
    expect([...bytes]).toEqual([1, 2, 3]);
    const init = fn.mock.calls[0]![1]!;
    expect(init).toMatchObject({
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      method: 'GET',
    });
    expect(progress).toHaveBeenLastCalledWith(3, null);
  });

  it('refuses a declared size over the limit without reading', async () => {
    const { fn, cancel } = fakeFetch([new Uint8Array(10)], { headers: { 'content-length': '11' } });
    await expect(fetchBundle(URL_A, { rules: PUBLIC, fetch: fn, maxBytes: 10 })).rejects.toThrow(
      /larger than 10 B/,
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('stops reading once the body passes the limit, whatever was declared', async () => {
    const { fn, cancel } = fakeFetch([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)], {
      headers: { 'content-length': '6' },
    });
    await expect(fetchBundle(URL_A, { rules: PUBLIC, fetch: fn, maxBytes: 10 })).rejects.toThrow(
      ViewerLoadError,
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('says what the server answered', async () => {
    const { fn } = fakeFetch([], { status: 404, statusText: 'Not Found' });
    await expect(fetchBundle(URL_A, { rules: PUBLIC, fetch: fn })).rejects.toThrow(
      'example.com answered 404 Not Found for the view.',
    );
  });

  it('names CORS when the download fails outright', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchBundle(URL_A, { rules: PUBLIC, fetch: fn })).rejects.toThrow(/CORS/);
  });

  it('refuses a redirect to an address a link could not name', async () => {
    const { fn } = fakeFetch([new Uint8Array(1)], { url: 'http://example.com/a.mfkview' });
    await expect(fetchBundle(URL_A, { rules: PUBLIC, fetch: fn })).rejects.toThrow(/redirected/);
  });

  it('passes an abort through as it is', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      fetchBundle(URL_A, { rules: PUBLIC, fetch: fn, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('readBundleFile', () => {
  it('reads a file under the limit and refuses a larger one unread', async () => {
    const file = new Blob([new Uint8Array([7, 8, 9])]);
    expect([...(await readBundleFile(file))]).toEqual([7, 8, 9]);
    const big = { size: MAX_BUNDLE_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    await expect(readBundleFile(big)).rejects.toThrow(/larger than 64 MB/);
    expect(big.arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('openBundle', () => {
  it('reads a bundle under the viewer limits', async () => {
    const view = openBundle(await boxBundle());
    expect(view.manifest.name).toBe('Bracket');
    expect(view.meshes).toHaveLength(2);
  });

  it('turns a damaged or foreign file into a message', () => {
    expect(() => openBundle(new Uint8Array([1, 2, 3]))).toThrow(ViewerLoadError);
    const notAView = zipSync({ 'hello.txt': new TextEncoder().encode('hi') });
    expect(() => openBundle(notAView)).toThrow(/manifest\.json/);
    const badManifest = zipSync({ 'manifest.json': new TextEncoder().encode('{"format":1}') });
    expect(() => openBundle(badManifest)).toThrow(/another format/);
    const notJson = zipSync({ 'manifest.json': new TextEncoder().encode('{') });
    expect(() => openBundle(notJson)).toThrow(/damaged/);
  });

  it('applies the viewer limits, not the writer limits', async () => {
    // 600 bodies is allowed to a writer (2000) but not to the viewer (500).
    const manifest = {
      format: 'manufakture-view',
      version: 1,
      generator: 'test',
      name: 'Many',
      kind: 'part',
      units: { length: 'mm', display: 'mm' },
      bodies: Array.from({ length: 600 }, () => ({
        name: 'b',
        color: null,
        material: null,
        volume: null,
        mass: null,
        faces: 1,
        edges: 0,
        triangles: 1,
      })),
      parts: [],
      instances: [],
      source: false,
    };
    const zip = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) });
    expect(() => openBundle(zip)).toThrow(/more than 500/);
  });

  it('has a message for anything', () => {
    expect(loadErrorMessage(new ViewerLoadError('x'))).toBe('x');
    expect(loadErrorMessage(new Error('internal detail'))).toBe('The view could not be opened.');
  });
});
