// The text code that loads the font parser: `TextEngine` (fonts loaded and kept, text laid out and
// outlined), served in the text worker by `serveText` (`text-worker.ts`), or run in this thread by
// `createTextOutliner`. See `text.ts` for why untrusted fonts belong in the text worker.

import {
  outlinePartsRegions,
  outlinePartsSize,
  type OutlinePartsResult,
} from '@manufakture/sketch';
import {
  FontError,
  bundledFont,
  fetchBundledFont,
  fontSha256,
  layoutText,
  loadFont,
  type LoadedFont,
} from '@manufakture/text';
import { decodeBase64 } from './imports';
import {
  MAX_FONT_NAME_LENGTH,
  MAX_TEXT_CURVES,
  MAX_TEXT_LOOPS,
  MAX_TEXT_POINTS,
  TextCancelled,
  budgetRefusal,
  fontKey,
  fontName,
  fontTooLarge,
  unreadableFont,
  type FontSummary,
  type TextOutliner,
  type TextReply,
  type WireFont,
  type WireInfo,
  type WireOutline,
  type WireReply,
  type WireRequest,
} from './text';

export interface TextEngineOptions {
  /** How bundled fonts are fetched (Node's `fetch` cannot read `file:` URLs: pass a reader). */
  fetchImpl?: (url: URL) => Promise<Response>;
  /** Fonts kept loaded, least recently used out first. Default 8. */
  maxFonts?: number;
}

type FontEntry = { sha256: string; font: LoadedFont } | { error: string; transient?: boolean };

/** Why a text is too complex to place, or null: see `MAX_TEXT_LOOPS`. */
export function textTooComplex(result: OutlinePartsResult): string | null {
  const size = outlinePartsSize(result);
  const over = (what: string, count: number, max: number) =>
    `this text is too complex to place: it makes ${count} ${what}, and a text may make at most ${max}; shorten it, or use a font with simpler glyphs`;
  if (size.loops > MAX_TEXT_LOOPS) return over('loops', size.loops, MAX_TEXT_LOOPS);
  if (size.curves > MAX_TEXT_CURVES) return over('curves', size.curves, MAX_TEXT_CURVES);
  if (size.points > MAX_TEXT_POINTS) return over('points', size.points, MAX_TEXT_POINTS);
  return null;
}

/** A string from a font file, cut to `MAX_FONT_NAME_LENGTH` characters. */
function clip(value: string): string {
  const chars = [...value];
  return chars.length <= MAX_FONT_NAME_LENGTH
    ? value
    : `${chars.slice(0, MAX_FONT_NAME_LENGTH - 1).join('')}\u2026`;
}

/** What `info` replies with: the font's names and permissions, every string cut to length. */
export function fontSummary(font: LoadedFont, sha256: string, size: number): FontSummary {
  const { info } = font;
  const summary: FontSummary = {
    family: clip(info.family),
    style: clip(info.style),
    fsType: info.fsType,
    embedding: {
      level: info.embedding.level,
      noSubsetting: info.embedding.noSubsetting,
      bitmapOnly: info.embedding.bitmapOnly,
      restrictive: info.embedding.restrictive,
    },
    outlines: info.outlines,
    variable: info.variable,
    glyphCount: info.glyphCount,
    sha256,
    size,
  };
  for (const key of ['fullName', 'version', 'copyright', 'license', 'licenseUrl'] as const) {
    const value = info[key];
    if (value !== undefined) summary[key] = clip(value);
  }
  return summary;
}

/**
 * The code that runs in the text worker (or in-process): fonts loaded once and kept by key (a
 * font that could not be parsed is remembered as failed; a bundled font that could not be
 * fetched, and a user font whose bytes do not match their SHA-256, are not), text laid out and
 * outlined per request.
 */
export class TextEngine {
  readonly #fetch: ((url: URL) => Promise<Response>) | undefined;
  readonly #max: number;
  readonly #fonts = new Map<string, FontEntry>();

  constructor(options: TextEngineOptions = {}) {
    this.#fetch = options.fetchImpl;
    this.#max = Math.max(1, options.maxFonts ?? 8);
  }

  /** Whether the user font with this SHA-256 is loaded (or known to be unreadable). */
  has(sha256: string): boolean {
    return this.#fonts.has(`file:${sha256}`);
  }

  #remember(key: string, entry: FontEntry): void {
    this.#fonts.delete(key);
    this.#fonts.set(key, entry);
    while (this.#fonts.size > this.#max) this.#fonts.delete(this.#fonts.keys().next().value!);
  }

  async #load(font: WireFont): Promise<FontEntry | null> {
    const key = fontKey(font);
    const known = this.#fonts.get(key);
    if (known) {
      this.#remember(key, known);
      return known;
    }
    let entry: FontEntry;
    if (font.kind === 'bundled') {
      const meta = bundledFont(font.id);
      if (!meta) {
        entry = { error: `this app has no bundled font "${font.id}"` };
      } else {
        let bytes: ArrayBuffer;
        try {
          bytes = await fetchBundledFont(font.id, this.#fetch);
        } catch (error) {
          // A fetch that failed may work next time: not remembered.
          return { error: error instanceof Error ? error.message : String(error), transient: true };
        }
        try {
          entry = { sha256: meta.sha256, font: loadFont(bytes) };
        } catch (error) {
          // The bytes matched their SHA-256, so parsing them fails the same way every time.
          entry = { error: error instanceof Error ? error.message : String(error) };
        }
      }
    } else {
      if (!font.bytes) return null;
      if (font.bytes.length !== font.size || (await fontSha256(font.bytes)) !== font.sha256) {
        // Not remembered: the key is the SHA-256 the document claims, so remembering would let a
        // damaged (or hostile) document block the real font with that SHA-256 for the session.
        return {
          error:
            'the stored copy does not match its SHA-256; the document is damaged: add the font again',
          transient: true,
        };
      }
      try {
        entry = { sha256: font.sha256, font: loadFont(font.bytes) };
      } catch (error) {
        entry = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.#remember(key, entry);
    return entry;
  }

  /** Load a font so later texts in it need not: `loaded`, a `font` failure, or `need-bytes`. */
  async load(font: WireFont): Promise<WireReply> {
    const loaded = await this.#load(font);
    if (loaded === null) {
      return { ok: false, code: 'need-bytes', message: `${fontName(font)} is not loaded` };
    }
    if ('error' in loaded) {
      return {
        ok: false,
        code: 'font',
        message: unreadableFont(fontName(font), loaded.error),
        ...(loaded.transient ? { transient: true } : {}),
      };
    }
    return { ok: true, code: 'loaded', sha256: loaded.sha256 };
  }

  /** Lay out and outline one text, loading its font first if need be. */
  async outline(request: Omit<WireOutline, 'op'> & { op?: 'outline' }): Promise<WireReply> {
    const loaded = await this.load(request.font);
    if (!loaded.ok) return loaded;
    const entry = this.#fonts.get(fontKey(request.font));
    if (!entry || 'error' in entry) {
      return { ok: false, code: 'need-bytes', message: `${fontName(request.font)} is not loaded` };
    }
    const { font } = entry;
    try {
      const layout = layoutText(font, request.text, {
        size: request.size,
        align: request.align.horizontal,
        verticalAlign: request.align.vertical,
        letterSpacing: request.letterSpacing,
        lineSpacing: request.lineSpacing,
      });
      const drawn = layout.glyphs.filter((g) => g.path.length > 0);
      const result = outlinePartsRegions(drawn.map((g) => g.path));
      const tooComplex = textTooComplex(result);
      if (tooComplex !== null) return { ok: false, code: 'glyph', message: tooComplex };
      return {
        ok: true,
        sha256: entry.sha256,
        glyphs: drawn.map((g) => g.index),
        result,
        missing: layout.missing,
        warnings: [...font.warnings],
      };
    } catch (error) {
      if (error instanceof FontError) return { ok: false, code: 'glyph', message: error.message };
      throw error;
    }
  }

  /**
   * Read a user font's names and permissions for **Add font**, and keep it loaded so the texts
   * set in it next need not parse it again. A font that cannot be parsed is a `font` failure.
   */
  async info(font: WireInfo['font']): Promise<WireReply> {
    // Checked here too, before anything is hashed or parsed: the request may not come from
    // `createWatchdogOutliner`.
    const tooLarge = fontTooLarge(font.fileName, Math.max(font.size, font.bytes.length));
    if (tooLarge) return { ok: false, code: 'font', message: tooLarge };
    const loaded = await this.#load(font);
    if (loaded === null) {
      return { ok: false, code: 'need-bytes', message: `${font.fileName} is not loaded` };
    }
    if ('error' in loaded) {
      return {
        ok: false,
        code: 'font',
        message: unreadableFont(font.fileName, loaded.error),
        ...(loaded.transient ? { transient: true } : {}),
      };
    }
    return { ok: true, code: 'info', info: fontSummary(loaded.font, loaded.sha256, font.size) };
  }

  /** Serve one request of the wire protocol. */
  handle(request: WireRequest): Promise<WireReply> {
    switch (request.op) {
      case 'load':
        return this.load(request.font);
      case 'info':
        return this.info(request.font);
      case 'outline':
        return this.outline(request);
    }
  }
}

export interface TextOutlinerOptions extends TextEngineOptions {
  /**
   * Read user (`file`) fonts too. Off by default: this outliner parses fonts in this thread with
   * no time limit, and a hostile font can hang it (ADR 0011's amendment). Only a host that runs
   * this thread under a limit of its own (a test, a command-line tool on trusted files) should
   * turn it on; a browser host passes `createWatchdogOutliner` to the engine instead.
   */
  allowFileFonts?: boolean;
}

/**
 * The text code in this thread, with no time limit: for Node and tests (see the module comment
 * of `text.ts`). Refuses user fonts unless `allowFileFonts`. Checks the regen's time budget
 * before each text and charges it after, but cannot stop a text once it runs.
 */
export function createTextOutliner(options: TextOutlinerOptions = {}): TextOutliner {
  const engine = new TextEngine(options);
  return {
    async outline(request, call = {}) {
      const { font } = request;
      if (font.kind === 'file' && !options.allowFileFonts) {
        return {
          ok: false,
          code: 'font',
          message: unreadableFont(
            font.fileName,
            'user fonts are read only in the text worker, under a time limit, and this host runs text without one',
          ),
          transient: true,
        };
      }
      const failedHere = call.budget?.failure(fontKey(font));
      if (failedHere !== undefined) {
        return { ok: false, code: 'font', message: failedHere, transient: true };
      }
      const refused = budgetRefusal(call.budget, font);
      if (refused) return refused;
      if (call.signal?.aborted) throw new TextCancelled();
      let wire: WireFont;
      if (font.kind === 'bundled') {
        wire = font;
      } else {
        const { data, ...rest } = font;
        wire = engine.has(font.sha256)
          ? rest
          : { ...rest, bytes: decodeBase64(data) ?? new Uint8Array(0) };
      }
      const started = performance.now();
      let reply: WireReply;
      try {
        reply = await engine.outline({ ...request, font: wire });
      } finally {
        const ms = performance.now() - started;
        call.budget?.charge(fontKey(font), ms, ms);
      }
      if (!reply.ok && reply.code === 'need-bytes') {
        return { ok: false, code: 'font', message: unreadableFont(fontName(font), reply.message) };
      }
      // A font that failed in a way that may not repeat (a bundled font that could not be
      // fetched) is not tried again in this regen.
      if (!reply.ok && reply.code === 'font' && reply.transient) {
        call.budget?.fail(fontKey(font), reply.message);
      }
      return reply as TextReply;
    },
  };
}

/**
 * Serves a `TextEngine` on a worker scope (`self` in the text worker): `{ ready: true }` once, then
 * `{ id, request }` in and `{ id, reply }` out. An unexpected error becomes a `font` failure,
 * never a missing reply.
 */
export function serveText(
  scope: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
  },
  engine: TextEngine = new TextEngine(),
): void {
  scope.onmessage = (event) => {
    const { id, request } = event.data as { id: number; request: WireRequest };
    engine
      .handle(request)
      .catch((error: unknown): WireReply => ({
        ok: false,
        code: 'font',
        message: unreadableFont(
          fontName(request.font),
          error instanceof Error ? error.message : String(error),
        ),
      }))
      .then((reply) => scope.postMessage({ id, reply }));
  };
  scope.postMessage({ ready: true });
}
