// Open in manufakture: handing a bundle's source `.mfk` from the viewer to the app, in a fresh tab.
//
// The viewer picks a random one-time token, opens the app at `./#open-view-source=<token>` in a
// new tab (with `noopener`, so neither page holds the other), and answers one request for that
// token on a same-origin BroadcastChannel with the bytes. The app, seeing the token in its
// fragment, removes it from the address bar, asks for the bytes, and imports them exactly as it
// imports a `.mfk` the person picked (the library checks every file it imports: `importMfk`).
// Nothing goes through a server, the URL carries only the token, and a page of another origin
// cannot join a BroadcastChannel of this one. The viewer stops offering after one answer or two
// minutes, whichever is first.
//
// Both sides live in this file so the message shapes cannot drift apart. It imports nothing: the
// app loads it at startup, the viewer when the button is used.

/** The channel both pages use. */
export const HANDOFF_CHANNEL = 'manufakture-view-source';
/** The app's fragment parameter that carries the token. */
export const HANDOFF_PARAM = 'open-view-source';
/** How long the viewer keeps offering, ms. */
export const OFFER_MS = 120_000;
/** How long the app waits for the viewer's answer, ms. */
export const RECEIVE_MS = 10_000;

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Request {
  type: 'request';
  token: string;
}

interface Answer {
  type: 'source';
  token: string;
  name: string;
  bytes: Uint8Array;
}

/** What a BroadcastChannel needs to be here (the real one, or a test double). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type ChannelFactory = (name: string) => ChannelLike;

const realChannel: ChannelFactory = (name) => new BroadcastChannel(name) as unknown as ChannelLike;

// The viewer's side ---------------------------------------------------------------------------

export interface OfferOptions {
  /** The app's address (the page the viewer sits beside). */
  appUrl: string;
  channel?: ChannelFactory;
  open?: (url: string) => void;
  token?: string;
  offerMs?: number;
}

/**
 * Offer `bytes` (a `.mfk`) to a new app tab, named `name` there. Returns a function that stops
 * offering early.
 */
export function offerSource(name: string, bytes: Uint8Array, options: OfferOptions): () => void {
  const token = options.token ?? crypto.randomUUID();
  const channel = (options.channel ?? realChannel)(HANDOFF_CHANNEL);
  let open = true;
  const stop = () => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    channel.onmessage = null;
    channel.close();
  };
  const timer = setTimeout(stop, options.offerMs ?? OFFER_MS);
  channel.onmessage = (event) => {
    const data = event.data as Partial<Request> | null;
    if (data?.type !== 'request' || data.token !== token) return;
    const answer: Answer = { type: 'source', token, name, bytes };
    channel.postMessage(answer);
    stop();
  };
  const url = new URL(options.appUrl);
  url.hash = `${HANDOFF_PARAM}=${token}`;
  const openTab = options.open ?? ((href: string) => void window.open(href, '_blank', 'noopener'));
  openTab(url.toString());
  return stop;
}

// The app's side ------------------------------------------------------------------------------

/** The token in an app fragment (`#open-view-source=<token>`), or null. */
export function handoffToken(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const prefix = `${HANDOFF_PARAM}=`;
  if (!h.startsWith(prefix)) return null;
  const token = h.slice(prefix.length);
  return TOKEN.test(token) ? token : null;
}

export interface ReceiveOptions {
  /** The largest `.mfk` accepted. */
  maxBytes: number;
  channel?: ChannelFactory;
  receiveMs?: number;
}

/** Ask the viewer for the source it offered under `token`. Rejects with a message to show. */
export function receiveSource(
  token: string,
  options: ReceiveOptions,
): Promise<{ name: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const channel = (options.channel ?? realChannel)(HANDOFF_CHANNEL);
    const done = () => {
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
    };
    const timer = setTimeout(() => {
      done();
      reject(
        new Error(
          'The viewer that offered this model did not answer. Keep its tab open and choose Open in manufakture again.',
        ),
      );
    }, options.receiveMs ?? RECEIVE_MS);
    channel.onmessage = (event) => {
      const data = event.data as Partial<Answer> | null;
      if (data?.type !== 'source' || data.token !== token) return;
      done();
      // Checked by tag, not `instanceof`: a structured clone may come from another realm.
      const tag = Object.prototype.toString.call(data.bytes);
      if (tag !== '[object Uint8Array]' || typeof data.name !== 'string') {
        reject(new Error('The viewer sent something that is not a model.'));
      } else if (data.bytes!.length > options.maxBytes) {
        reject(new Error('The model from the viewer is larger than a .mfk file may be.'));
      } else {
        resolve({ name: data.name, bytes: data.bytes! });
      }
    };
    const request: Request = { type: 'request', token };
    channel.postMessage(request);
  });
}

let claimed = false;

/**
 * The app's hook: when the page was opened by the viewer (a token in the fragment), take the
 * token out of the address bar, fetch the source and import it with `importFile`. Runs once per
 * page load whatever React does with effects; `report` gets the outcome's message.
 */
export function acceptViewSource(
  importFile: (file: {
    name: string;
    bytes: Uint8Array;
  }) => Promise<{ ok: boolean; message: string }>,
  report: (status: { error: boolean; text: string }) => void,
  options: ReceiveOptions & { location?: Location; history?: History },
): void {
  const location = options.location ?? window.location;
  const history = options.history ?? window.history;
  const token = handoffToken(location.hash);
  if (!token || claimed) return;
  claimed = true;
  const url = new URL(location.href);
  url.hash = '';
  history.replaceState(history.state, '', url.toString());
  receiveSource(token, options)
    .then((file) => importFile({ name: safeFileName(file.name), bytes: file.bytes }))
    .then((outcome) => report({ error: !outcome.ok, text: outcome.message }))
    .catch((e: unknown) =>
      report({ error: true, text: e instanceof Error ? e.message : String(e) }),
    );
}

/** For tests: forget that this page load claimed a token. */
export function resetHandoffForTests(): void {
  claimed = false;
}

// The name only labels the import in messages: keep it short and plain.
function safeFileName(name: string): string {
  const plain = name
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${plain || 'shared model'}.mfk`;
}
