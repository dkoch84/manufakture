// Text for regen: the font of an outline entity loaded, its string laid out and its glyphs turned
// into region loops (`packages/text`, then `outlinePartsRegions`), ready to be placed in the
// sketch (`placeOutline`).
//
// User fonts are attack surface (ADR 0011 decision 7 and its amendment): `loadFont`,
// `layoutText` and `outlineRegions` bound every cost they can, but a CFF font's subroutine
// fan-out is bounded only by time. So the regen worker runs that code in a text worker of its own
// under a `Watchdog` (`createWatchdogOutliner`, set up by `worker.ts`): a font is loaded by one
// request and each text laid out by another, each under the time limit, so a timeout says which
// of the two was too slow. A font that cannot be read in time, or crashes the worker, is "this
// font could not be read", the same as a `FontError`; a text that cannot be laid out in time
// fails alone. On top of the per-request limit, a regen's texts share a time budget
// (`TextBudget`): per font, so a font whose every text takes just under the limit is failed once
// its texts have used it up, and per regen, so a document of many slow texts cannot stall the
// regen for minutes.
//
// This module does not load the font parser (opentype.js): the code that does, `TextEngine` and
// the in-process `createTextOutliner`, is in `text-engine.ts`, which the regen worker loads only
// when it runs text in-process.

import type { OutlineAlign } from '@manufakture/core';
import type { OutlinePartsResult } from '@manufakture/sketch';
import { decodeBase64 } from './imports';
import { Watchdog, WatchdogError, type WorkerLike } from './watchdog';

/** A font as regen asks for it: bundled by id, or a user file (its base64 text from the document). */
export type TextFontRef =
  | { kind: 'bundled'; id: string }
  | { kind: 'file'; fileName: string; size: number; sha256: string; data: string };

export interface TextRequest {
  font: TextFontRef;
  text: string;
  /** Cap height in millimetres, above 0. */
  size: number;
  align: OutlineAlign;
  /** Millimetres. */
  letterSpacing: number;
  /** A multiple of the font's line height. */
  lineSpacing: number;
}

export type TextReply =
  | {
      ok: true;
      /** The SHA-256 of the font file the text was set in. */
      sha256: string;
      /** Per path of `result` (`part`), the glyph's position in the text. */
      glyphs: number[];
      result: OutlinePartsResult;
      /** Characters the font has no glyph for, each once. */
      missing: string[];
      /** Problems with the font that did not stop it (a kerning table that could not be read). */
      warnings: string[];
    }
  | {
      ok: false;
      /**
       * `font`: the font could not be read (damaged, hostile, too slow, out of memory); every text
       * in it fails. `glyph`: this text could not be laid out (a glyph that could not be read, a
       * text too complex or too slow).
       */
      code: 'font' | 'glyph';
      message: string;
      /**
       * The failure may not happen again (a bundled font that could not be fetched in time, a
       * worker that could not be started, a regen's time budget used up): the sketch's result
       * must not be cached.
       */
      transient?: boolean;
    };

/** What one `outline` call may use besides the request. */
export interface TextCallOptions {
  /** Aborted when a newer regen supersedes this one: the call stops and rejects. */
  signal?: AbortSignal;
  /** The regen's time budget for text; see `TextBudget`. */
  budget?: TextBudget;
}

/** Lays out and outlines text; one call per outline entity. */
export interface TextOutliner {
  outline(request: TextRequest, options?: TextCallOptions): Promise<TextReply>;
}

/** The message a user sees for a font that could not be read. */
export function unreadableFont(name: string, why: string): string {
  return `This font could not be read (${name}): ${why}`;
}

export function fontName(
  font: { kind: 'bundled'; id: string } | { kind: 'file'; fileName: string },
): string {
  return font.kind === 'bundled' ? font.id : font.fileName;
}

/** The key a font is known by: `bundled:<id>` or `file:<sha256>`. */
export function fontKey(
  font: { kind: 'bundled'; id: string } | { kind: 'file'; sha256: string },
): string {
  return font.kind === 'bundled' ? `bundled:${font.id}` : `file:${font.sha256}`;
}

// Limits ---------------------------------------------------------------------------------------

/** Time one request (loading a font, or laying out one text) may take in the text worker, in ms. */
export const TEXT_TIME_LIMIT_MS = 10_000;

/** Time the texts of one font may take in all in one regen, in ms: past it the font fails. */
export const TEXT_FONT_BUDGET_MS = 10_000;

/** Time every text of one regen may take in all, in ms: past it the remaining texts fail. */
export const TEXT_REGEN_BUDGET_MS = 30_000;

/**
 * Most outer loops and holes one text may make. 10,000 characters of Latin text in Inter Bold
 * (what core allows all the texts of a sketch together; one text may have 1000) make about
 * 12,000 loops, 167,000 curves and 448,000 points; the limits are about four times that in loops
 * and three in curves and points. A real text stays far below them; a hostile font whose glyphs
 * are made of thousands of contours does not, and the limits bound the work of placing its text
 * in the sketch (`detectRegions`) and of sending it across.
 */
export const MAX_TEXT_LOOPS = 50_000;
/** Most curves (lines, arcs, Beziers) one text may make; see `MAX_TEXT_LOOPS`. */
export const MAX_TEXT_CURVES = 500_000;
/** Most points (line and arc ends, Bezier control points) one text may make; see `MAX_TEXT_LOOPS`. */
export const MAX_TEXT_POINTS = 1_500_000;

/**
 * The time a regen's texts have taken, per font and in all, against `TEXT_FONT_BUDGET_MS` and
 * `TEXT_REGEN_BUDGET_MS`, and the fonts that failed in this regen. The engine makes one per regen;
 * outliners check it before a text and charge it after (loading the font included). A text that
 * starts just under a budget may run its whole time limit, so a font can take up to
 * `perFont` plus one `TEXT_TIME_LIMIT_MS` (about 2 x 10 s) and the regen up to `total` plus one
 * time limit before the budget refuses the next text.
 */
export class TextBudget {
  readonly perFont: number;
  readonly total: number;
  readonly #fonts = new Map<string, number>();
  readonly #failed = new Map<string, string>();
  #spent = 0;

  constructor(options: { perFont?: number; total?: number } = {}) {
    this.perFont = options.perFont ?? TEXT_FONT_BUDGET_MS;
    this.total = options.total ?? TEXT_REGEN_BUDGET_MS;
  }

  /** Milliseconds the texts of the font with this key (`fontKey`) have taken. */
  spentOn(key: string): number {
    return this.#fonts.get(key) ?? 0;
  }

  /** Milliseconds every text has taken. */
  get spent(): number {
    return this.#spent;
  }

  /** `font` when this font's texts have used their time, `regen` when all texts have, else null. */
  check(key: string): 'font' | 'regen' | null {
    if (this.spentOn(key) > this.perFont) return 'font';
    if (this.#spent > this.total) return 'regen';
    return null;
  }

  /** `fontMs` spent on a text of the font with this key, `totalMs` in all for the call. */
  charge(key: string, fontMs: number, totalMs: number = fontMs): void {
    this.#fonts.set(key, this.spentOn(key) + fontMs);
    this.#spent += totalMs;
  }

  /**
   * Remember for the rest of this regen that the font with this key (or the text worker, under
   * `TEXT_WORKER_KEY`) failed, and why: a failure that may not repeat in a later regen (a bundled
   * font that could not be loaded in time, a worker that could not be started) is not remembered
   * by the outliner, but must not cost the time limit once per text of the same regen. For a font,
   * `why` is the message its texts fail with; for the worker, the reason it could not start.
   */
  fail(key: string, why: string): void {
    if (!this.#failed.has(key)) this.#failed.set(key, why);
  }

  /** What `fail` recorded for this key in this regen, or undefined. */
  failure(key: string): string | undefined {
    return this.#failed.get(key);
  }
}

/** The `TextBudget.fail` key for "the text worker could not be started". */
export const TEXT_WORKER_KEY = 'worker';

/**
 * The reply for a text the budget refuses, or null. A font past its budget fails as unreadable
 * (`font`); every text past the regen's budget fails on its own (`glyph`), not remembered.
 */
export function budgetRefusal(
  budget: TextBudget | undefined,
  font: TextFontRef,
): Extract<TextReply, { ok: false }> | null {
  const over = budget?.check(fontKey(font));
  if (!over || !budget) return null;
  if (over === 'font') {
    return {
      ok: false,
      code: 'font',
      message: unreadableFont(
        fontName(font),
        `its texts took longer than ${budget.perFont} ms in all to lay out`,
      ),
      // A bundled font is never failed for the session, only for this regen.
      ...(font.kind === 'bundled' ? { transient: true } : {}),
    };
  }
  return {
    ok: false,
    code: 'glyph',
    message: `this text was not laid out: the document's texts took longer than ${budget.total} ms in all`,
    transient: true,
  };
}

const now = () => performance.now();

/** Thrown by an outliner when its call was aborted (`TextCallOptions.signal`). */
export class TextCancelled extends Error {
  constructor() {
    super('The text was not laid out: a newer regen superseded this one.');
    this.name = 'TextCancelled';
  }
}

// The wire protocol between the regen worker and the text worker --------------------------------

/** A font as it crosses to the text worker: a user font's bytes only when the worker lacks them. */
export type WireFont =
  | { kind: 'bundled'; id: string }
  | { kind: 'file'; fileName: string; size: number; sha256: string; bytes?: Uint8Array };

/** Load a font (fetch a bundled one, parse either), so that later texts need not. */
export interface WireLoad {
  op: 'load';
  font: WireFont;
}

/** Lay out and outline one text in a font the worker has loaded. */
export interface WireOutline extends Omit<TextRequest, 'font'> {
  op: 'outline';
  font: WireFont;
}

export type WireRequest = WireLoad | WireOutline;

/** A reply from the text worker: as `TextReply`, "the font is loaded", or "send the font's bytes". */
export type WireReply =
  | TextReply
  | { ok: true; code: 'loaded'; sha256: string }
  | { ok: false; code: 'need-bytes'; message: string };

// The regen worker's side --------------------------------------------------------------------

export interface WatchdogOutlinerOptions {
  /** Default `TEXT_TIME_LIMIT_MS`. */
  timeLimit?: number;
}

/**
 * A `TextOutliner` that runs every request in a worker from `spawn` under a `Watchdog`. A font is
 * loaded by a request of its own the first time a worker needs it (a user font's bytes go with
 * it), then each text is laid out by another. A load that times out or crashes the worker fails
 * the font as "this font could not be read"; a user font that does so is not tried again. A
 * text that times out fails alone ("this text could not be laid out in time"), and the next
 * request starts a new worker. Failures that may not repeat are not remembered for the session:
 * a bundled font (its fetch may have been slow), and a worker that could not be started; they are
 * remembered on the call's `TextBudget` for the rest of the regen, so each costs the time limit at
 * most once per regen. The time a call takes, loading included, is charged to its font.
 */
export function createWatchdogOutliner(
  spawn: () => WorkerLike,
  options: WatchdogOutlinerOptions = {},
): TextOutliner & { readonly watchdog: Watchdog<WireRequest, WireReply> } {
  const timeLimit = options.timeLimit ?? TEXT_TIME_LIMIT_MS;
  // `serveText` says when the worker has started, so a worker that never starts is not
  // mistaken for a font that hangs.
  const watchdog = new Watchdog<WireRequest, WireReply>(spawn, { timeLimit, ready: true });
  // Fonts the current worker has loaded, by key.
  let loaded = new Set<string>();
  let generation = -1;
  // A worker that is gone (timed out, crashed, cancelled) took its fonts with it.
  const sync = () => {
    if (watchdog.generation !== generation || !watchdog.running) {
      loaded = new Set();
      generation = watchdog.generation;
    }
  };
  // User fonts whose reading timed out, crashed the worker or used up their time budget, by key:
  // not tried again, so one hostile font costs the time limit once, not once per text.
  const failed = new Map<string, string>();

  const load = (font: TextFontRef, signal: AbortSignal | undefined): Promise<WireReply> => {
    if (font.kind === 'bundled') return watchdog.call({ op: 'load', font }, [], signal);
    const { data, ...rest } = font;
    const bytes = decodeBase64(data) ?? new Uint8Array(0);
    return watchdog.call(
      { op: 'load', font: { ...rest, bytes } },
      [bytes.buffer as ArrayBuffer],
      signal,
    );
  };
  const layout = (request: TextRequest, signal: AbortSignal | undefined) => {
    const { font } = request;
    let wire: WireFont = font;
    if (font.kind === 'file') {
      // The worker has the bytes (it loaded the font): send the rest.
      const { data, ...rest } = font;
      void data;
      wire = rest;
    }
    return watchdog.call({ ...request, op: 'outline', font: wire }, [], signal);
  };

  return {
    watchdog,
    async outline(request, call = {}) {
      const { font } = request;
      const name = fontName(font);
      const key = fontKey(font);
      const { budget } = call;
      const known = failed.get(key);
      if (known !== undefined) return { ok: false, code: 'font', message: known };
      // Failures this regen already met, which may not repeat in a later one.
      const failedHere = budget?.failure(key);
      if (failedHere !== undefined) {
        return { ok: false, code: 'font', message: failedHere, transient: true };
      }
      const noWorker = budget?.failure(TEXT_WORKER_KEY);
      if (noWorker !== undefined) {
        return {
          ok: false,
          code: 'font',
          message: unreadableFont(name, `the text worker could not be started (${noWorker})`),
          transient: true,
        };
      }
      const refuse = () => {
        const refused = budgetRefusal(budget, font);
        if (refused?.code === 'font' && font.kind === 'file') failed.set(key, refused.message);
        return refused;
      };
      const refused = refuse();
      if (refused) return refused;
      if (call.signal?.aborted) throw new TextCancelled();

      // Everything the call takes, loading the font included, is charged to the font: a font
      // whose load is slow uses up its budget like one whose texts are.
      let mark = now();
      const settle = () => {
        const at = now();
        budget?.charge(key, at - mark);
        mark = at;
      };
      let phase: 'load' | 'layout' | undefined;
      try {
        for (let attempt = 0; ; attempt++) {
          sync();
          if (!loaded.has(key)) {
            phase = 'load';
            const reply = await load(font, call.signal);
            sync();
            if (!reply.ok) {
              const why = reply.message;
              const transient =
                font.kind === 'bundled' || (reply.code === 'font' && reply.transient === true);
              const message = reply.code === 'font' ? why : unreadableFont(name, why);
              // Not tried again in this regen, though a later regen may. (A user font that
              // could not be parsed fails fast: the text worker remembers it.)
              if (transient) budget?.fail(key, message);
              return {
                ok: false,
                code: 'font',
                message,
                ...(transient ? { transient: true } : {}),
              };
            }
            loaded.add(key);
          }
          phase = 'layout';
          const reply = await layout(request, call.signal);
          sync();
          // The worker let the font go (it keeps a few): load it again, once, if the budget allows.
          if (!reply.ok && reply.code === 'need-bytes') {
            loaded.delete(key);
            if (attempt === 0) {
              settle();
              const again = refuse();
              if (again) return again;
              continue;
            }
            return { ok: false, code: 'font', message: unreadableFont(name, reply.message) };
          }
          return reply as TextReply;
        }
      } catch (error) {
        if (!(error instanceof WatchdogError)) throw error;
        if (error.reason === 'cancelled') throw new TextCancelled();
        if (error.reason === 'spawn') {
          budget?.fail(TEXT_WORKER_KEY, error.message);
          return {
            ok: false,
            code: 'font',
            message: unreadableFont(
              name,
              `the text worker could not be started (${error.message})`,
            ),
            transient: true,
          };
        }
        const timedOut = error.reason === 'timeout';
        if (phase === 'layout') {
          return {
            ok: false,
            code: 'glyph',
            message: timedOut
              ? `this text could not be laid out in time (it took longer than ${timeLimit} ms)`
              : 'laying out this text ran out of memory or crashed',
          };
        }
        const message = unreadableFont(
          name,
          timedOut
            ? `reading it took longer than ${timeLimit} ms`
            : 'reading it ran out of memory or crashed',
        );
        budget?.fail(key, message);
        if (font.kind === 'bundled') return { ok: false, code: 'font', message, transient: true };
        failed.set(key, message);
        return { ok: false, code: 'font', message };
      } finally {
        settle();
      }
    },
  };
}

/**
 * An outliner that loads `text-engine.ts` (and with it opentype.js) on its first call: what
 * `RegenEngine` uses when given none, so a host that passes its own never loads the parser.
 */
export function lazyTextOutliner(options: { allowFileFonts?: boolean } = {}): TextOutliner {
  let inner: Promise<TextOutliner> | null = null;
  return {
    async outline(request, call) {
      inner ??= import('./text-engine').then((m) => m.createTextOutliner(options));
      return (await inner).outline(request, call);
    },
  };
}
