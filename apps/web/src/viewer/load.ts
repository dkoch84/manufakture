// Getting a `.mfkview` into the viewer: from a picked or dropped file, or from the link's
// fragment (`viewer.html#src=<https URL>`, the M7 plan's decision 5: the bundle's address rides in
// the fragment, which the browser never sends, so the viewer's host never learns which model is
// opened). Everything here treats its input as hostile:
//
// - A link names an absolute https URL. Plain http is accepted only for localhost, and only when
//   the viewer itself is served from localhost (tests and local development), so a link cannot make
//   someone's browser poke at services on their own machine. No user name or password in the URL.
// - The download sends no cookies or other credentials and no referrer, follows redirects only to
//   addresses that pass the same check, and reads the body as a stream that is cut off past the
//   size limit, whatever the Content-Length said.
// - The bytes are read with `readMfkview` under `MFKVIEW_VIEWER_LIMITS` (the io README,
//   "Published views"), smaller than the limits a bundle may be written with. The source `.mfk`
//   inside is not inflated here: only when the person asks to open it in manufakture.
//
// Every failure is a `ViewerLoadError` whose message is fit to show as it is.

import {
  MFKVIEW_VIEWER_LIMITS,
  MfkviewError,
  readMfkview,
  type Mfkview,
} from '@manufakture/io/mfkview';
import { displayText } from './displayText';

/** A bundle that cannot be loaded, worded for the person who opened it. */
export class ViewerLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewerLoadError';
  }
}

/** The largest bundle the viewer reads, downloaded or picked. */
export const MAX_BUNDLE_BYTES = MFKVIEW_VIEWER_LIMITS.maxFileBytes;

/** The longest bundle address read from a link. */
export const MAX_SOURCE_URL_LENGTH = 4096;

/** The fragment parameter that names a bundle. */
export const SOURCE_PARAM = 'src';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface SourceRules {
  /** Accept http://localhost addresses (only when the viewer runs on localhost itself). */
  allowLocalHttp: boolean;
}

/** The rules for a viewer served from `location`. */
export function rulesFor(location: { hostname: string }): SourceRules {
  return { allowLocalHttp: LOCAL_HOSTS.has(location.hostname) };
}

/** A byte count for messages: `512 B`, `12.3 KB`, `64 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * The bundle address in a fragment (`#src=<url>`), or null when the fragment names none. The
 * address is everything after `src=`, so it may carry its own query and `&`; it may also be
 * percent-encoded whole (`#src=https%3A%2F%2F...`).
 */
export function sourceFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const prefix = `${SOURCE_PARAM}=`;
  if (!h.startsWith(prefix)) return null;
  let raw = h.slice(prefix.length);
  if (/^https?%3a/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Left as it was; the URL check says what is wrong with it.
    }
  }
  return raw.length > 0 ? raw : null;
}

/** `raw` as a URL the viewer may download, or a `ViewerLoadError` saying why not. */
export function checkSourceUrl(raw: string, rules: SourceRules): URL {
  if (raw.length > MAX_SOURCE_URL_LENGTH) {
    throw new ViewerLoadError(
      `The link's bundle address is longer than ${MAX_SOURCE_URL_LENGTH} characters.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ViewerLoadError(
      'The link does not name a bundle address this viewer can read: it must be a full https:// address.',
    );
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  const allowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && local && rules.allowLocalHttp);
  if (!allowed) {
    throw new ViewerLoadError("The link's bundle address must start with https://.");
  }
  if (url.username !== '' || url.password !== '') {
    throw new ViewerLoadError(
      "The link's bundle address must not contain a user name or password.",
    );
  }
  return url;
}

export interface FetchOptions {
  rules: SourceRules;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Bytes read so far, and the total when the server said it. */
  onProgress?: (loaded: number, total: number | null) => void;
  /** For tests. */
  fetch?: typeof fetch;
}

const tooBig = (max: number) =>
  new ViewerLoadError(
    `The view is larger than ${formatBytes(max)}, the most this viewer opens. Download it and open it in manufakture instead.`,
  );

/** Download a bundle within the size limit. */
export async function fetchBundle(url: URL, options: FetchOptions): Promise<Uint8Array> {
  const max = options.maxBytes ?? MAX_BUNDLE_BYTES;
  const doFetch = options.fetch ?? fetch;
  const host = displayText(url.host, 'the server');
  let response: Response;
  try {
    response = await doFetch(url.href, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new ViewerLoadError(
      `The view could not be downloaded from ${host}. The server may be unreachable, or it does not let this viewer read the file (it must send CORS headers; see the sharing guide).`,
    );
  }
  // A redirect must land somewhere the link itself could have named.
  if (response.url) {
    try {
      checkSourceUrl(response.url, options.rules);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new ViewerLoadError(
        `${host} redirected the download to an address this viewer does not open.`,
      );
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const text = displayText(response.statusText, '', 60);
    throw new ViewerLoadError(
      `${host} answered ${response.status}${text ? ` ${text}` : ''} for the view.`,
    );
  }
  const declared = Number(response.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > max) {
    await response.body?.cancel().catch(() => undefined);
    throw tooBig(max);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw tooBig(max);
    return bytes;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    if (loaded > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(max);
    }
    parts.push(value);
    options.onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The bytes of a picked or dropped file, refused unread when it is over the limit. */
export async function readBundleFile(file: Blob, maxBytes = MAX_BUNDLE_BYTES): Promise<Uint8Array> {
  if (file.size > maxBytes) throw tooBig(maxBytes);
  return new Uint8Array(await file.arrayBuffer());
}

/** Read a bundle under the viewer's limits. */
export function openBundle(bytes: Uint8Array): Mfkview {
  try {
    return readMfkview(bytes, MFKVIEW_VIEWER_LIMITS);
  } catch (e) {
    if (e instanceof MfkviewError) throw new ViewerLoadError(e.message);
    throw new ViewerLoadError('This file could not be read as a manufakture view (.mfkview).');
  }
}

/** A message for any failure while loading. */
export function loadErrorMessage(e: unknown): string {
  if (e instanceof ViewerLoadError) return e.message;
  return 'The view could not be opened.';
}
