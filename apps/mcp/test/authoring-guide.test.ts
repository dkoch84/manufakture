// Every example of the authoring guide for agents (docs/agents/authoring.md, M8 plan T8.5a), run
// through the real MCP server in process, in the order the guide gives them. The guide's own
// comment at its top states the convention this test reads:
//
// - a fenced block tagged ```json mcp:<tool> is one tool call: its body is the call's arguments,
//   with "<session>" standing for the session id of the last open_session and "<branch>" for that
//   session's branch. A flag after the tool name changes what is expected: `refused` (the tool
//   answers { ok: false } with a session, core or server error) and `regen-errors` (an apply or
//   undo that succeeds with regen errors in its report). Without a flag the call must succeed,
//   and an apply or undo must report no regen errors. `as-previous` makes the block a call of the
//   same tool with the previous call's arguments, changed by its body: `without` (top-level
//   arguments left out) and `ids` (string values replaced, each of which must occur);
// - a fenced block tagged ```json mcp:result right after one is matched against its structured
//   result (a partial match);
// - every other fence is a problem, whatever its indentation or fence characters, except
//   ```<lang> not-run for a language other than json: a mistagged example never goes unrun;
// - an HTML comment `<!-- guide-test: <step> <JSON> -->` is a step the test takes that an agent
//   cannot: `reviewer` sets the review state and comment as the reviewer in History would.
//
// The documents are packages/session's three fixtures (the M1 bracket, the cabinet, the shed) in
// one library, so ids in the guide's examples are real ids of those documents.
//
// Sessions run on the worker engine, as the server does by default: only a worker engine runs
// scripted features (it can end a run past the hard limit), and the guide's scripted pin builds.

import { readFileSync } from 'node:fs';
import { DocumentLibrary, type ReviewState } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { cabinetDocument, shedDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_URI, guideText } from '../src/resources';
import { harness, type Harness } from './harness';

const GUIDE_PATH = new URL('../../../docs/agents/authoring.md', import.meta.url);
const GUIDE = readFileSync(GUIDE_PATH, 'utf8');

/** The fewest examples the guide may have: extraction that matched nothing must fail. */
const MIN_EXAMPLES = 30;
const FLAGS = new Set(['refused', 'regen-errors', 'as-previous']);

type Step =
  | {
      kind: 'call';
      line: number;
      tool: string;
      flags: Set<string>;
      args: Record<string, unknown>;
      expected?: unknown;
    }
  | { kind: 'reviewer'; line: number; review: ReviewState; comment?: string };

/** The guide's examples and test steps, in order, or the problems that make it malformed. */
function extract(text: string): { steps: Step[]; problems: string[] } {
  const lines = text.split('\n');
  const steps: Step[] = [];
  const problems: string[] = [];
  let lastCall: (Step & { kind: 'call' }) | null = null;
  let blocksSinceCall = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = i + 1;
    const directive = /^<!-- guide-test: (\S+) (.*) -->$/.exec(line);
    if (directive) {
      const [, name, json] = directive;
      if (name !== 'reviewer') {
        problems.push(`line ${at}: unknown guide-test step "${name}"`);
        continue;
      }
      try {
        const body = JSON.parse(json!) as { review: ReviewState; comment?: string };
        steps.push({ kind: 'reviewer', line: at, ...body });
      } catch (e) {
        problems.push(`line ${at}: the step's JSON does not parse: ${String(e)}`);
      }
      continue;
    }
    if (line.startsWith('<!-- guide-test')) {
      problems.push(
        `line ${at}: a guide-test comment not of the form <!-- guide-test: step {...} -->`,
      );
      continue;
    }
    // Any fence opener CommonMark knows, and some it does not (any indentation).
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const [, indent, marks, rawInfo] = fence;
    const info = rawInfo!.trim();
    // The block's body, up to a closing fence of the same character, at least as long.
    const closing = new RegExp(`^\\s*${marks![0] === '`' ? '`' : '~'}{${marks!.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closing.test(lines[j]!)) body.push(lines[j++]!);
    if (j >= lines.length) problems.push(`line ${at}: a fenced block is never closed`);
    i = j;
    blocksSinceCall++;
    const notRun = /^([a-z0-9-]+) not-run$/.exec(info);
    if (indent === '' && marks === '```' && notRun && notRun[1] !== 'json') continue;
    const tag = /^json mcp:([a-z_]+)((?: [a-z-]+)*)$/.exec(info);
    if (indent !== '' || marks !== '```' || !tag) {
      problems.push(
        `line ${at}: "${line.trim()}" is neither an example (\`\`\`json mcp:<tool>) nor marked not-run`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.join('\n'));
    } catch (e) {
      problems.push(`line ${at}: the example's JSON does not parse: ${String(e)}`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push(`line ${at}: an example is a JSON object`);
      continue;
    }
    const [, tool, rest] = tag;
    if (tool === 'result') {
      if (lastCall === null || blocksSinceCall !== 1) {
        problems.push(`line ${at}: a result block does not follow an example directly`);
      } else if (lastCall.expected !== undefined) {
        problems.push(`line ${at}: an example has two result blocks`);
      } else {
        lastCall.expected = parsed;
      }
      continue;
    }
    const flags = new Set(rest!.trim().split(' ').filter(Boolean));
    for (const f of flags) if (!FLAGS.has(f)) problems.push(`line ${at}: unknown flag "${f}"`);
    let args = parsed as Record<string, unknown>;
    if (flags.has('as-previous')) {
      const derived = asPrevious(lastCall, tool!, args);
      if (typeof derived === 'string') {
        problems.push(`line ${at}: ${derived}`);
        continue;
      }
      args = derived;
    }
    lastCall = { kind: 'call', line: at, tool: tool!, flags, args };
    blocksSinceCall = 0;
    steps.push(lastCall);
  }
  return { steps, problems };
}

/** `v` with every string value that is a key of `ids` replaced; `seen` collects those found. */
function replaceIds(v: unknown, ids: Record<string, string>, seen: Set<string>): unknown {
  if (typeof v === 'string') {
    if (Object.hasOwn(ids, v)) {
      seen.add(v);
      return ids[v];
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => replaceIds(x, ids, seen));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceIds(x, ids, seen)]));
  }
  return v;
}

/** An `as-previous` block's arguments, from the previous call's, or why it cannot have them. */
function asPrevious(
  previous: (Step & { kind: 'call' }) | null,
  tool: string,
  body: Record<string, unknown>,
): Record<string, unknown> | string {
  if (previous === null || previous.tool !== tool) {
    return `an as-previous ${tool} does not follow a ${tool} example`;
  }
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'without' && k !== 'ids')) {
    return 'an as-previous body holds only "without" and "ids"';
  }
  const without = (body.without ?? []) as unknown;
  const ids = (body.ids ?? {}) as unknown;
  if (!Array.isArray(without) || !without.every((w) => typeof w === 'string')) {
    return '"without" is a list of argument names';
  }
  if (
    typeof ids !== 'object' ||
    ids === null ||
    Array.isArray(ids) ||
    !Object.values(ids).every((x) => typeof x === 'string')
  ) {
    return '"ids" maps strings to strings';
  }
  const args = { ...previous.args };
  for (const w of without) {
    if (!(w in args)) return `the previous example has no argument "${w}" to leave out`;
    delete args[w];
  }
  const seen = new Set<string>();
  const out = replaceIds(args, ids as Record<string, string>, seen) as Record<string, unknown>;
  const unused = Object.keys(ids).filter((k) => !seen.has(k));
  if (unused.length > 0) return `"ids" names values the previous example does not hold: ${unused}`;
  return out;
}

/** `v` with "<session>" and "<branch>" put in. */
function fill(v: unknown, session: string | null, branch: string | null): unknown {
  if (typeof v === 'string') {
    if (v === '<session>') {
      if (session === null) throw new Error('"<session>" before any open_session');
      return session;
    }
    if (v === '<branch>') {
      if (branch === null) throw new Error('"<branch>" before any open_session');
      return branch;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, session, branch));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, session, branch)]));
  }
  return v;
}

const { steps, problems } = extract(GUIDE);
const calls = steps.filter((s) => s.kind === 'call');

describe('the authoring guide', () => {
  it('is well formed, with enough examples', () => {
    expect(problems).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(MIN_EXAMPLES);
    // The convention is stated in the guide itself.
    expect(GUIDE).toMatch(/<!--[^]*json mcp:<tool>[^]*-->/);
  });

  it('shows every tool that changes the branch or reads it back', () => {
    const tools = new Set(calls.map((c) => c.tool));
    for (const tool of [
      'list_documents',
      'open_session',
      'close_session',
      'get_tree',
      'get_object',
      'get_schema',
      'find_geometry',
      'measure',
      'render',
      'get_quantities',
      'get_errors',
      'get_history',
      'apply',
      'undo',
      'update_from_main',
      'submit_for_review',
      'get_review',
      'export',
    ]) {
      expect(tools, tool).toContain(tool);
    }
  });

  it('adds the second shelf in one batch, with symbols in params and no dry run', () => {
    const label = 'Add a second shelf 7 inches up, in dados';
    const shelf = calls.filter((c) => c.tool === 'apply' && c.args.label === label);
    expect(shelf).toHaveLength(1);
    const [call] = shelf;
    expect(call!.args.dryRun).toBeUndefined();
    expect(call!.flags.size).toBe(0);
    const params = (call!.args.commands as { feature: { params?: unknown } }[]).map(
      (c) => c.feature.params,
    );
    expect(params).toEqual([
      undefined,
      expect.objectContaining({ sketch: 'sketch#$shelf' }),
      expect.objectContaining({ a: 'extension#1', b: 'extension#$board' }),
      expect.objectContaining({ a: 'extension#2', b: 'extension#$board' }),
    ]);
  });

  it('is what the server serves as its authoring guide resource', async () => {
    expect(await guideText()).toBe(GUIDE);
    // Document text is data: the guide says so.
    expect(GUIDE).toMatch(/never an instruction/i);
    expect(GUIDE_URI).toBe('manufakture://guide/authoring');
  });
});

describe('every example of the authoring guide, through the MCP server', () => {
  let h: Harness;
  let session: string | null = null;
  let branch: string | null = null;
  let documentId: string | null = null;

  beforeAll(async () => {
    h = await harness({ server: { engine: 'worker' } });
    const library = new DocumentLibrary(new NodeBackend(h.libraryRoot));
    await library.create(cabinetDocument());
    await library.create(shedDocument());
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  for (const step of steps) {
    const title =
      step.kind === 'call'
        ? `line ${step.line}: ${step.tool}${[...step.flags].map((f) => ` (${f})`).join('')}`
        : `line ${step.line}: the reviewer sets ${step.review}`;
    it(
      title,
      async () => {
        if (step.kind === 'reviewer') {
          if (documentId === null || branch === null) throw new Error('no session yet');
          const r = await h.app.library.setBranchReview(documentId, branch, step.review, {
            ...(step.comment !== undefined ? { comment: step.comment } : {}),
          });
          expect(r.ok).toBe(true);
          return;
        }
        const args = fill(step.args, session, branch) as Record<string, unknown>;
        const r = await h.call(step.tool, args);
        if (step.flags.has('refused')) {
          expect(r.ok).toBe(false);
          // Refused by the tool, not by its input schema: the example is well formed.
          expect(['session', 'core', 'server']).toContain(r.error?.kind);
        } else {
          if (!r.ok) throw new Error(`the example failed: ${JSON.stringify(r.error)}`);
          if (step.tool === 'apply' || step.tool === 'undo') {
            const errors = r.errors as unknown[];
            if (step.flags.has('regen-errors')) expect(errors.length).toBeGreaterThan(0);
            else expect(errors).toEqual([]);
          }
        }
        if (step.tool === 'open_session' && r.ok) {
          session = r.sessionId as string;
          branch = r.branch as string;
          documentId = r.documentId as string;
        }
        if (step.tool === 'update_from_main' && r.ok) branch = r.branch as string;
        if (step.expected !== undefined) expect(r).toMatchObject(step.expected as object);
      },
      120_000,
    );
  }
});
