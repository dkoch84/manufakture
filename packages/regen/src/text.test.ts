// Text for regen: the in-process outliner against the bundled font, user fonts by bytes, and the
// watchdog that runs untrusted fonts in a worker under a time limit (ADR 0011's amendment).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  detectRegions,
  outlineRegionArea,
  outlineRegions,
  placeOutline,
  type SketchEntity,
} from '@manufakture/sketch';
import { INTER_BOLD, bundledFontUrl, layoutText, loadFont } from '@manufakture/text';
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_CURVES,
  MAX_TEXT_LOOPS,
  TextBudget,
  TextCancelled,
  createWatchdogOutliner,
  fontKey,
  lazyTextOutliner,
  type TextRequest,
  type WireRequest,
} from './text';
import { TextEngine, createTextOutliner, serveText, textTooComplex } from './text-engine';
import { fromDisk } from './test-helpers';
import { Watchdog, WatchdogError, type WorkerLike } from './watchdog';

const interBytes = () => new Uint8Array(readFileSync(fileURLToPath(bundledFontUrl(INTER_BOLD.id))));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const request = (
  text: string,
  font: TextRequest['font'] = { kind: 'bundled', id: 'inter-bold' },
): TextRequest => ({
  font,
  text,
  size: 10,
  align: { horizontal: 'left', vertical: 'baseline' },
  letterSpacing: 0,
  lineSpacing: 1,
});

async function userFont(bytes: Uint8Array, fileName = 'user.ttf'): Promise<TextRequest['font']> {
  return {
    kind: 'file',
    fileName,
    size: bytes.length,
    sha256: await sha256(bytes),
    data: base64(bytes),
  };
}

describe('the in-process outliner', () => {
  it('lays out text in the bundled font and outlines every glyph', async () => {
    const outliner = createTextOutliner({ fetchImpl: fromDisk });
    const reply = await outliner.outline(request('O i'));
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.sha256).toBe(INTER_BOLD.sha256);
    // The space draws nothing: glyphs 0 ("O") and 2 ("i").
    expect(reply.glyphs).toEqual([0, 2]);
    expect(reply.missing).toEqual([]);
    expect(reply.result.issues).toEqual([]);
    expect(reply.result.regions.map((r) => [r.outer.part, r.holes.length])).toEqual([
      [0, 1],
      [1, 0],
      [1, 0],
    ]);
    // The same areas as the glyphs converted one by one.
    const font = loadFont(interBytes());
    const layout = layoutText(font, 'O i', { size: 10 });
    const expected = layout.glyphs
      .flatMap((g) => outlineRegions(g.path).regions)
      .reduce((a, r) => a + outlineRegionArea(r), 0);
    const got = reply.result.regions.reduce(
      (a, r) => a + r.outer.area + r.holes.reduce((b, h) => b + h.area, 0),
      0,
    );
    expect(got).toBeCloseTo(expected, 9);
  });

  it('reports characters the font lacks', async () => {
    const reply = await createTextOutliner({ fetchImpl: fromDisk }).outline(request('⌀8'));
    expect(reply.ok && reply.missing).toEqual(['⌀']);
  });

  it('reads a user font from its bytes, once, checking them against the SHA-256', async () => {
    const bytes = interBytes();
    const font = await userFont(bytes);
    const outliner = createTextOutliner({ allowFileFonts: true });
    const first = await outliner.outline(request('H', font));
    expect(first.ok && first.sha256).toBe(font.kind === 'file' && font.sha256);
    // The data is not decoded again once the font is loaded.
    const second = await outliner.outline(
      request('H', { ...font, data: '' } as TextRequest['font']),
    );
    expect(second.ok).toBe(true);
    const damaged = await outliner.outline(
      request('H', {
        ...(await userFont(bytes, 'other.ttf')),
        sha256: 'f'.repeat(64),
      } as TextRequest['font']),
    );
    expect(damaged).toEqual({
      ok: false,
      code: 'font',
      message: expect.stringMatching(
        /^This font could not be read \(other\.ttf\): .*does not match its SHA-256/,
      ),
      transient: true,
    });
  });

  it('does not remember a copy that does not match its SHA-256, so it cannot block the real font', async () => {
    const real = await userFont(interBytes(), 'real.ttf');
    if (real.kind !== 'file') throw new Error('a file font');
    // A hostile document claims the real font's SHA-256 for other bytes.
    const junk = new TextEncoder().encode('not the font at all');
    const claimed = { ...real, fileName: 'claimed.ttf', size: junk.length, data: base64(junk) };
    const outliner = createTextOutliner({ allowFileFonts: true });
    const refused = await outliner.outline(request('H', claimed));
    expect(refused).toMatchObject({ ok: false, code: 'font', transient: true });
    expect((await outliner.outline(request('H', real))).ok).toBe(true);
  });

  it('fails a file that is not a font as "this font could not be read"', async () => {
    const junk = new TextEncoder().encode('not a font at all, just text');
    const reply = await createTextOutliner({ allowFileFonts: true }).outline(
      request('A', await userFont(junk, 'junk.ttf')),
    );
    expect(reply).toEqual({
      ok: false,
      code: 'font',
      message: expect.stringMatching(/^This font could not be read \(junk\.ttf\)/),
    });
  });

  it('refuses user fonts unless the host opts in, as it parses them with no time limit', async () => {
    const reply = await createTextOutliner().outline(request('A', await userFont(interBytes())));
    expect(reply).toEqual({
      ok: false,
      code: 'font',
      message: expect.stringMatching(
        /^This font could not be read \(user\.ttf\): user fonts are read only in the text worker/,
      ),
      transient: true,
    });
    // Bundled fonts are fine.
    expect((await createTextOutliner({ fetchImpl: fromDisk }).outline(request('A'))).ok).toBe(true);
  });

  it('loads the default outliner (and the font parser) only when the first text needs it', async () => {
    const reply = await lazyTextOutliner().outline(request('A', await userFont(interBytes())));
    expect(reply).toMatchObject({ ok: false, code: 'font', transient: true });
  });

  it('refuses a text past the time budget of its font or of the regen', async () => {
    const outliner = createTextOutliner({ fetchImpl: fromDisk, allowFileFonts: true });
    const user = await userFont(interBytes());
    const budget = new TextBudget({ perFont: 1000, total: 5000 });
    expect((await outliner.outline(request('A', user), { budget })).ok).toBe(true);
    expect(budget.spentOn(fontKey(user as { kind: 'file'; sha256: string }))).toBeGreaterThan(0);
    budget.charge(fontKey(user as { kind: 'file'; sha256: string }), 1001);
    expect(await outliner.outline(request('B', user), { budget })).toEqual({
      ok: false,
      code: 'font',
      message:
        'This font could not be read (user.ttf): its texts took longer than 1000 ms in all to lay out',
    });
    // The bundled font still has its time; then the regen runs out.
    expect((await outliner.outline(request('B'), { budget })).ok).toBe(true);
    budget.charge('bundled:inter-bold', 0, 5000);
    expect(await outliner.outline(request('C'), { budget })).toEqual({
      ok: false,
      code: 'glyph',
      message: expect.stringMatching(
        /^this text was not laid out: the document's texts took longer than 5000 ms/,
      ),
      transient: true,
    });
  });

  it('refuses a text that makes more loops than a text may', async () => {
    const reply = await createTextOutliner({ fetchImpl: fromDisk }).outline(request('O'));
    if (!reply.ok) throw new Error(reply.message);
    expect(textTooComplex(reply.result)).toBeNull();
    const many = {
      ...reply.result,
      regions: Array(MAX_TEXT_LOOPS + 1).fill(reply.result.regions[0]!),
    };
    expect(textTooComplex(many)).toMatch(/^this text is too complex to place: it makes \d+ loops/);
    expect(MAX_TEXT_LOOPS).toBe(50_000);
    expect(MAX_TEXT_CURVES).toBe(500_000);
  });
});

describe('cost of a long text', () => {
  it('lays out, outlines and finds the regions of 1000 characters in a plate (logged)', async () => {
    const base = 'The quick brown fox jumps over the lazy dog 0123456789. ';
    const chars = [...base.repeat(20)].slice(0, 1000);
    const lines: string[] = [];
    for (let i = 0; i < chars.length; i += 50) lines.push(chars.slice(i, i + 50).join(''));
    const outliner = createTextOutliner({ fetchImpl: fromDisk });
    await outliner.outline(request('warm up'));
    const t0 = performance.now();
    const reply = await outliner.outline({ ...request(lines.join('\n')), size: 5 });
    const t1 = performance.now();
    if (!reply.ok) throw new Error(reply.message);
    const shapes = placeOutline(
      { id: 'e5', anchor: [10, -10], angle: 0 },
      reply.glyphs,
      reply.result,
    );
    const plate: SketchEntity[] = [
      { id: 'l1', kind: 'line', construction: false, start: [0, -400], end: [300, -400] },
      { id: 'l2', kind: 'line', construction: false, start: [300, -400], end: [300, 10] },
      { id: 'l3', kind: 'line', construction: false, start: [300, 10], end: [0, 10] },
      { id: 'l4', kind: 'line', construction: false, start: [0, 10], end: [0, -400] },
    ];
    const found = detectRegions(plate, { outlines: shapes });
    const t2 = performance.now();
    console.log(
      `1000 characters, ${reply.glyphs.length} glyphs drawn: layout and outlines ${(t1 - t0).toFixed(0)} ms, regions ${(t2 - t1).toFixed(0)} ms (${found.regions.length} regions)`,
    );
    expect(found.diagnostics).toEqual([]);
    // Every glyph region, every counter, and the plate with a hole per glyph region.
    const plateRegion = found.regions.find((r) => r.id.startsWith('l1'))!;
    expect(plateRegion.holes).toHaveLength(shapes.length);
    expect(found.regions.length).toBe(
      1 + shapes.length + shapes.reduce((n, s) => n + s.holes.length, 0),
    );
  });
});

/** A node:worker_threads worker running `code` (CommonJS), as a `WorkerLike`. */
function nodeWorker(
  code: string,
  options: ConstructorParameters<typeof Worker>[1] = {},
): WorkerLike {
  const worker = new Worker(code, { eval: true, ...options });
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
    terminate: () => void worker.terminate(),
  };
  worker.on('message', (data) => like.onmessage?.({ data } as MessageEvent));
  worker.on('error', (error) =>
    like.onerror?.({ message: String(error), preventDefault() {} } as unknown as ErrorEvent),
  );
  return like;
}

/** Doubles numbers; hangs on "hang", throws on "crash", runs out of memory on "oom". */
const TOY = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, request }) => {
  if (request === 'hang') for (;;) {}
  if (request === 'crash') throw new Error('boom');
  if (request === 'oom') { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())); }
  parentPort.postMessage({ id, reply: request * 2 });
});
`;

describe('Watchdog', () => {
  it('runs requests one at a time in one worker', async () => {
    let spawned = 0;
    const dog = new Watchdog<number | string, number>(() => (spawned++, nodeWorker(TOY)), {
      timeLimit: 5000,
    });
    expect(await Promise.all([dog.call(1), dog.call(2), dog.call(3)])).toEqual([2, 4, 6]);
    expect(spawned).toBe(1);
    expect(dog.generation).toBe(1);
    dog.terminate();
  });

  it('terminates a worker that passes the time limit, and starts a new one for the next request', async () => {
    let spawned = 0;
    const dog = new Watchdog<number | string, number>(() => (spawned++, nodeWorker(TOY)), {
      timeLimit: 300,
    });
    const started = performance.now();
    const hung = dog.call('hang');
    const after = dog.call(21);
    await expect(hung).rejects.toMatchObject({ name: 'WatchdogError', reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await after).toBe(42);
    expect(spawned).toBe(2);
    expect(dog.generation).toBe(2);
    dog.terminate();
  });

  it('reports a worker that crashes or runs out of memory as crashed', async () => {
    const dog = new Watchdog<number | string, number>(
      () => nodeWorker(TOY, { resourceLimits: { maxOldGenerationSizeMb: 32 } }),
      { timeLimit: 20_000 },
    );
    await expect(dog.call('crash')).rejects.toMatchObject({ reason: 'crashed' });
    await expect(dog.call('oom')).rejects.toBeInstanceOf(WatchdogError);
    expect(await dog.call(5)).toBe(10);
    dog.terminate();
  }, 30_000);
});

/**
 * A text worker in this thread: `serveText` on a fake scope. Requests for `hangOn` (a font file
 * name, or `text:<text>` for a text) never answer, as a hostile font would hang the real worker.
 * Each fake keeps its own engine, as a real worker would.
 */
function fakeTextWorker(
  log: WireRequest[],
  hangOn?: string,
  engine = new TextEngine({ fetchImpl: fromDisk }),
): WorkerLike & { terminated: boolean } {
  const like: WorkerLike & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (message) => {
      const { request } = message as { request: WireRequest };
      log.push(request);
      if (request.font.kind === 'file' && request.font.fileName === hangOn) return;
      if (request.op === 'outline' && `text:${request.text}` === hangOn) return;
      scope.onmessage?.({ data: message } as MessageEvent);
    },
    terminate: () => {
      like.terminated = true;
    },
  };
  const scope = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (reply: unknown) =>
      queueMicrotask(() => like.onmessage?.({ data: reply } as MessageEvent)),
  };
  serveText(scope, engine);
  return like;
}

/** What a log shows: each request's op, and whether a user font's bytes went with it. */
const ops = (log: readonly WireRequest[]) =>
  log.map((r) => `${r.op}${r.font.kind === 'file' && r.font.bytes !== undefined ? '+bytes' : ''}`);

describe('createWatchdogOutliner', () => {
  it('loads a font once per worker, sends a user font once, and answers as the engine does', async () => {
    const log: WireRequest[] = [];
    const outliner = createWatchdogOutliner(() => fakeTextWorker(log), { timeLimit: 5000 });
    const font = await userFont(interBytes());
    const a = await outliner.outline(request('A', font));
    const b = await outliner.outline(request('B', font));
    expect(a.ok && b.ok).toBe(true);
    const bundled = await outliner.outline(request('C'));
    expect(bundled.ok).toBe(true);
    expect(ops(log)).toEqual(['load+bytes', 'outline', 'outline', 'load', 'outline']);
  });

  it('turns a font that hangs into "this font could not be read", once, and keeps working', async () => {
    const log: WireRequest[] = [];
    let spawned = 0;
    const outliner = createWatchdogOutliner(() => (spawned++, fakeTextWorker(log, 'evil.otf')), {
      timeLimit: 200,
    });
    const good = await userFont(interBytes());
    const evil = await userFont(new Uint8Array([1, 2, 3, 4]), 'evil.otf');
    expect((await outliner.outline(request('A', good))).ok).toBe(true);
    const hung = await outliner.outline(request('A', evil));
    expect(hung).toEqual({
      ok: false,
      code: 'font',
      message: 'This font could not be read (evil.otf): reading it took longer than 200 ms',
    });
    // Not tried again: one hostile font costs the time limit once.
    expect(await outliner.outline(request('B', evil))).toEqual(hung);
    expect(
      log.filter((r) => r.font.kind === 'file' && r.font.fileName === 'evil.otf'),
    ).toHaveLength(1);
    // The new worker gets the good font's bytes again.
    log.length = 0;
    expect((await outliner.outline(request('A', good))).ok).toBe(true);
    expect(spawned).toBe(2);
    expect(ops(log)).toEqual(['load+bytes', 'outline']);
  });

  it('blames a text, not its font, when laying it out takes too long', async () => {
    const log: WireRequest[] = [];
    const outliner = createWatchdogOutliner(() => fakeTextWorker(log, 'text:slow'), {
      timeLimit: 200,
    });
    const font = await userFont(interBytes());
    expect(await outliner.outline(request('slow', font))).toEqual({
      ok: false,
      code: 'glyph',
      message: 'this text could not be laid out in time (it took longer than 200 ms)',
    });
    // The font is not failed: the next text in it works, in a new worker.
    expect((await outliner.outline(request('fast', font))).ok).toBe(true);
  });

  it('fails a user font whose texts use up its time budget, for the session', async () => {
    const log: WireRequest[] = [];
    const outliner = createWatchdogOutliner(() => fakeTextWorker(log, 'text:slow'), {
      timeLimit: 100,
    });
    const font = await userFont(interBytes());
    const budget = new TextBudget({ perFont: 150, total: 60_000 });
    // Each slow text costs the time limit; the second one takes the font past its budget.
    expect((await outliner.outline(request('slow', font), { budget })).ok).toBe(false);
    expect((await outliner.outline(request('slow', font), { budget })).ok).toBe(false);
    const refused = await outliner.outline(request('fast', font), { budget });
    expect(refused).toEqual({
      ok: false,
      code: 'font',
      message:
        'This font could not be read (user.ttf): its texts took longer than 150 ms in all to lay out',
    });
    // Remembered, even in a later regen with a fresh budget.
    expect(await outliner.outline(request('fast', font), { budget: new TextBudget() })).toEqual(
      refused,
    );
  });

  it('does not remember a bundled font that failed, so a slow fetch costs one regen only', async () => {
    const log: WireRequest[] = [];
    let slow = true;
    const outliner = createWatchdogOutliner(
      () =>
        fakeTextWorker(
          log,
          slow ? 'never' : undefined,
          slowBundledEngine(() => slow),
        ),
      { timeLimit: 200 },
    );
    const first = await outliner.outline(request('A'));
    expect(first).toEqual({
      ok: false,
      code: 'font',
      message: 'This font could not be read (inter-bold): reading it took longer than 200 ms',
      transient: true,
    });
    slow = false;
    expect((await outliner.outline(request('A'))).ok).toBe(true);
  });

  it('spends the time limit once per regen on a bundled font whose load never answers', async () => {
    const log: WireRequest[] = [];
    let spawned = 0;
    let slow = true;
    const outliner = createWatchdogOutliner(
      () => (
        spawned++,
        fakeTextWorker(
          log,
          undefined,
          slowBundledEngine(() => slow),
        )
      ),
      { timeLimit: 100 },
    );
    const budget = new TextBudget({ perFont: 60_000, total: 60_000 });
    const started = performance.now();
    const replies = [];
    for (let i = 0; i < 6; i++) replies.push(await outliner.outline(request(`T${i}`), { budget }));
    const failure = {
      ok: false,
      code: 'font',
      message: 'This font could not be read (inter-bold): reading it took longer than 100 ms',
      transient: true,
    };
    // Every text gets the font's own failure, not "the texts took too long in all".
    expect(replies).toEqual(Array.from({ length: 6 }, () => failure));
    expect(spawned).toBe(1);
    expect(ops(log)).toEqual(['load']);
    expect(performance.now() - started).toBeLessThan(1000);
    // The load is charged to the font.
    expect(budget.spentOn('bundled:inter-bold')).toBeGreaterThanOrEqual(100);
    // A later regen tries again.
    slow = false;
    expect((await outliner.outline(request('A'), { budget: new TextBudget() })).ok).toBe(true);
  });

  it('starts no worker again in a regen whose worker could not be started', async () => {
    let spawned = 0;
    const outliner = createWatchdogOutliner(
      () => {
        spawned++;
        throw new Error('no workers here');
      },
      { timeLimit: 1000 },
    );
    const budget = new TextBudget();
    const font = await userFont(interBytes());
    const first = await outliner.outline(request('A', font), { budget });
    const second = await outliner.outline(request('B'), { budget });
    expect(spawned).toBe(1);
    expect(second).toEqual({
      ok: false,
      code: 'font',
      message:
        'This font could not be read (inter-bold): the text worker could not be started (The worker could not be started: Error: no workers here)',
      transient: true,
    });
    expect(first).toMatchObject({ ok: false, code: 'font', transient: true });
  });

  it('checks the budget before loading a font again for a worker that let it go', async () => {
    const log: WireRequest[] = [];
    // A worker that loads every font and then has always let it go by the time a text comes.
    const forgetful = (): WorkerLike => {
      const like: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (message) => {
          const { id, request } = message as { id: number; request: WireRequest };
          log.push(request);
          const reply =
            request.op === 'load'
              ? { ok: true, code: 'loaded', sha256: INTER_BOLD.sha256 }
              : { ok: false, code: 'need-bytes', message: 'not loaded' };
          queueMicrotask(() => like.onmessage?.({ data: { id, reply } } as MessageEvent));
        },
        terminate: () => undefined,
      };
      queueMicrotask(() => like.onmessage?.({ data: { ready: true } } as MessageEvent));
      return like;
    };
    const outliner = createWatchdogOutliner(forgetful, { timeLimit: 1000 });
    const budget = new TextBudget({ perFont: 0, total: 60_000 });
    const reply = await outliner.outline(request('A'), { budget });
    expect(reply).toMatchObject({ ok: false, code: 'font', transient: true });
    if (!reply.ok) expect(reply.message).toMatch(/took longer than 0 ms in all/);
    expect(ops(log)).toEqual(['load', 'outline']);
  });

  it('does not remember a font when the worker could not be started', async () => {
    let fail = true;
    const log: WireRequest[] = [];
    const outliner = createWatchdogOutliner(
      () => {
        if (fail) throw new Error('no workers here');
        return fakeTextWorker(log);
      },
      { timeLimit: 1000 },
    );
    const font = await userFont(interBytes());
    const reply = await outliner.outline(request('A', font));
    expect(reply).toMatchObject({ ok: false, code: 'font', transient: true });
    if (!reply.ok) expect(reply.message).toMatch(/the text worker could not be started/);
    fail = false;
    expect((await outliner.outline(request('A', font))).ok).toBe(true);
  });

  it('does not blame a font when the worker dies before it started', async () => {
    let broken = true;
    const log: WireRequest[] = [];
    const outliner = createWatchdogOutliner(
      () => {
        if (!broken) return fakeTextWorker(log);
        // A worker whose script fails to load: an error, and never a message.
        const like: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: () =>
            queueMicrotask(() => like.onerror?.({ preventDefault() {} } as unknown as ErrorEvent)),
          terminate: () => undefined,
        };
        return like;
      },
      { timeLimit: 1000 },
    );
    const font = await userFont(interBytes());
    expect(await outliner.outline(request('A', font))).toMatchObject({
      ok: false,
      code: 'font',
      transient: true,
    });
    broken = false;
    expect((await outliner.outline(request('A', font))).ok).toBe(true);
  });

  it('stops the text in flight when its signal is aborted, terminating the worker', async () => {
    const log: WireRequest[] = [];
    const workers: ReturnType<typeof fakeTextWorker>[] = [];
    const outliner = createWatchdogOutliner(
      () => {
        const w = fakeTextWorker(log, 'text:slow');
        workers.push(w);
        return w;
      },
      { timeLimit: 60_000 },
    );
    const font = await userFont(interBytes());
    const abort = new AbortController();
    const started = performance.now();
    const pending = outliner.outline(request('slow', font), { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(TextCancelled);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(workers[0]!.terminated).toBe(true);
    // Not remembered: the font works in the next worker.
    expect((await outliner.outline(request('fast', font))).ok).toBe(true);
    // A call whose signal is already aborted never runs.
    await expect(
      outliner.outline(request('fast', font), { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(TextCancelled);
  });
});

/** A `TextEngine` whose bundled font fetch never ends while `slow()` (a slow network). */
function slowBundledEngine(slow: () => boolean): TextEngine {
  return new TextEngine({
    fetchImpl: (url) => (slow() ? new Promise<Response>(() => undefined) : fromDisk(url)),
  });
}
