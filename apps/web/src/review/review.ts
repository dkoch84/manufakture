// The logic of the Review view (M8 plan T8.3b, ADR 0016 decisions 4 and 11): reading an agent
// branch's review bundle, checking it against the branch head, comparing it with the app's own
// regen of the head, and the gate in front of **Approve**. The bundle is untrusted: it is read
// with `@manufakture/review/data`'s `readBundle`, which checks sizes and nesting but not every
// field's type, so everything here reads it through `list`, `text` and `num`, which never throw
// and never let a value of the wrong type through.

import { findMaterial, massGrams, type ManufaktureDocument } from '@manufakture/core';
import {
  type Branch,
  type BranchProvenance,
  type LibraryResult,
  type MergePlan,
  type Opened,
  type ReviewState,
  type Version,
} from '@manufakture/library';
import { isStale, readBundle, type ReviewBundle } from '@manufakture/review/data';
import type { PartModel } from '../model/model';

// Reading untrusted values --------------------------------------------------------------------

/** `x` when it is a list, else an empty one. */
export const list = (x: unknown): readonly unknown[] => (Array.isArray(x) ? x : []);

/** `x` as text: a string as it is, a finite number written out, anything else empty. */
export function text(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return '';
}

/** `x` when it is a finite number, else null. */
export const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

/** `x` when it is a plain object, else an empty one. */
export const obj = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/** A count from the bundle (`omitted`): a non-negative safe integer, else 0. */
export function count(x: unknown): number {
  return Number.isSafeInteger(x) && (x as number) > 0 ? (x as number) : 0;
}

/** `s` cut to `max` characters, with an ellipsis when it was longer. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/**
 * Whether `s` holds characters a reader cannot see or that change how text around them reads:
 * control and format characters (bidirectional overrides, zero-width marks) other than tabs and
 * line breaks, and lone surrogates. Computed here from the text shown, never taken from a bundle.
 */
export const hasHiddenCharacters = (s: string): boolean =>
  /[\p{Cs}]|(?![\n\t\r])[\p{Cc}\p{Cf}]/u.test(s);

const INVISIBLE = /[\p{Cs}]|(?![\n\t])[\p{Cc}\p{Cf}]/gu;

/**
 * `s` with every control and format character and lone surrogate (bidirectional overrides,
 * zero-width marks, a carriage return) written as an escape like `\u{202e}`; tabs and line breaks
 * stay as they are.
 */
export const visible = (s: string): string =>
  s.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).padStart(4, '0')}}`);

/** A number for people: up to 10 significant digits, no exponent below 1e15. */
export function shownNumber(x: number | null): string {
  if (x === null) return 'none';
  const r = Number(x.toPrecision(10));
  return Math.abs(r) < 1e15 ? String(r) : r.toExponential(6);
}

/**
 * Whether two JSON values are equal, whatever the order of object keys (a key holding undefined
 * counts as absent). Iterative, so a deep document cannot overflow the stack.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  const stack: [unknown, unknown][] = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    // A key holding undefined is absent in JSON.
    const ox = x as Record<string, unknown>;
    const oy = y as Record<string, unknown>;
    const kx = Object.keys(ox).filter((k) => ox[k] !== undefined);
    const ky = Object.keys(oy).filter((k) => oy[k] !== undefined);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
      if (oy[k] === undefined) return false;
      stack.push([ox[k], oy[k]]);
    }
  }
  return true;
}

// Agent branches ----------------------------------------------------------------------------

/** A branch an agent session made: it has provenance. */
export type AgentBranch = Branch & { provenance: BranchProvenance };

export const isAgentBranch = (b: Branch | null | undefined): b is AgentBranch =>
  b !== null && b !== undefined && b.provenance?.origin === 'agent';

/** The document's agent branches, in the library's order. */
export const agentBranches = (branches: readonly Branch[] | null): AgentBranch[] =>
  (branches ?? []).filter(isAgentBranch);

/** How each review state reads in History. */
export const REVIEW_STATE_TEXT: Record<ReviewState, string> = {
  open: 'Open: the agent is working',
  submitted: 'Submitted for review',
  'changes-requested': 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** The review state's text; a state this release does not know reads as itself. */
export const reviewStateText = (state: string): string =>
  (REVIEW_STATE_TEXT as Record<string, string>)[state] ?? clip(state, 40);

// Loading a bundle --------------------------------------------------------------------------

/** What the Review view reads from the library. */
export interface ReviewSource {
  reviewBundle(
    id: string,
    branch: string,
  ): Promise<LibraryResult<{ revision: number; record: unknown } | null>>;
  reviewImage(id: string, sha256: string): Promise<Uint8Array | null>;
  open(id: string, branch?: string): Promise<LibraryResult<Opened>>;
  previewMerge(
    id: string,
    from: string,
    into: string,
    options?: { document?: ManufaktureDocument },
  ): Promise<LibraryResult<MergePlan>>;
  setBranchReview(
    id: string,
    branch: string,
    review: ReviewState,
    options?: { expected?: ReviewState | readonly ReviewState[]; comment?: string | null },
  ): Promise<LibraryResult<Branch>>;
  listVersions(id: string, branch?: string): Promise<LibraryResult<Version[]>>;
}

/** The longest agent note shown before "Show all" (a session allows 4,000 characters). */
export const MAX_NOTE = 4000;

export type LoadedReview =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      bundle: ReviewBundle;
      /** The agent's note to the reviewer: untrusted text. */
      note: string;
      /** The head revision the bundle was built at. */
      revision: number;
      /** The branch head now. */
      head: { revision: number; document: ManufaktureDocument };
      /** The bundle no longer describes the head (a write came after it, or another base). */
      stale: boolean;
    };

/**
 * The newest bundle of agent branch `branch`, read and checked: its envelope, its bounds
 * (`readBundle`), that it is for this document and branch, and whether it is stale against the
 * branch's head now.
 */
export async function loadReview(
  source: Pick<ReviewSource, 'reviewBundle' | 'open'>,
  documentId: string,
  branch: AgentBranch,
): Promise<LoadedReview> {
  const stored = await source.reviewBundle(documentId, branch.id);
  if (!stored.ok) return { kind: 'error', message: stored.message };
  if (stored.value === null) return { kind: 'none' };
  const record = obj(stored.value.record);
  const read = readBundle(record.bundle);
  if (!read.ok) return { kind: 'error', message: read.message };
  const bundle = read.bundle;
  if (bundle.key.documentId !== documentId || bundle.key.branch !== branch.id) {
    return { kind: 'error', message: 'The bundle is for another document or branch.' };
  }
  if (bundle.key.headRevision !== stored.value.revision) {
    return { kind: 'error', message: 'The bundle is not stored under the revision it names.' };
  }
  const opened = await source.open(documentId, branch.id);
  if (!opened.ok) return { kind: 'error', message: opened.message };
  const head = { revision: opened.value.revision, document: opened.value.document };
  const stale = isStale(bundle, {
    branch: branch.id,
    revision: head.revision,
    ...(branch.fromVersion === null ? {} : { baseVersion: branch.fromVersion }),
  });
  return {
    kind: 'ready',
    bundle,
    note: typeof record.note === 'string' ? record.note.slice(0, MAX_NOTE) : '',
    revision: bundle.key.headRevision,
    head,
    stale,
  };
}

// Comparing with the app's regen ------------------------------------------------------------

/**
 * How close a measurement here must be to the bundle's: a relative 1e-9 (T8.0a found the kernel
 * bit-identical between Node and the browser; JavaScript `Math` differs by an ULP or two, far
 * inside this) or 1e-6 in absolute terms (mm, mm², mm³, g) near zero.
 */
export const TOLERANCE = { relative: 1e-9, absolute: 1e-6 } as const;

export function close(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    Math.max(TOLERANCE.absolute, TOLERANCE.relative * Math.max(Math.abs(a), Math.abs(b)))
  );
}

/** A body measured here: the kernel's volume, area and box, or why it was not. */
export type MeasuredHere =
  | {
      ok: true;
      volume: number;
      area: number;
      boundingBox: { min: readonly number[]; max: readonly number[] } | null;
    }
  | { ok: false; message: string };

export interface RegenCheck {
  /** Every difference between the bundle and this regen: approval waits for none. */
  mismatches: string[];
  /**
   * What this regen has that the bundle may have left out (its lists were cut at their limits),
   * so it could not be compared: approval waits for the reviewer to acknowledge each.
   */
  unverified: string[];
  /** What was not compared, and why. */
  notes: string[];
  /** Bodies compared. */
  bodies: number;
}

/** The most mismatches listed; the rest are counted. */
export const MAX_MISMATCHES = 200;

/**
 * Compare the bundle's head with this app's regen of the same head (ADR 0016 decision 4): the
 * bodies (by part and body id), their names where this app can tell them, their volume, area,
 * bounding box and mass within `TOLERANCE`, and the error codes of features. Never mesh hashes or
 * cache keys. Scripted features are left out of the error comparison: a session's engine runs no
 * script, and here they run only when the reviewer allows them.
 *
 * It fails closed. A body the bundle lists without a measurement at head, a body this app cannot
 * measure, and a body or error on one side only are mismatches. Where the bundle cut a list at its
 * limit (`omitted`), what it lists must still be here; what this regen has beyond the list is a
 * mismatch when it is more than the bundle left out, and otherwise `unverified`, which approval
 * also waits on until the reviewer acknowledges it. So a bundle that lists no bodies and says it
 * left them all out never passes by itself.
 */
export async function compareRegen(input: {
  bundle: ReviewBundle;
  document: ManufaktureDocument;
  parts: readonly PartModel[];
  measure: (viewId: string) => Promise<MeasuredHere>;
}): Promise<RegenCheck> {
  const { bundle, document, parts } = input;
  const mismatches: string[] = [];
  const unverified: string[] = [];
  const notes: string[] = [];
  const add = (m: string) => {
    mismatches.push(m);
  };
  const measurements = obj(bundle.measurements);
  const bodiesList = obj(measurements.bodies);
  const omittedBodies = count(bodiesList.omitted);
  const partName = (partId: string) => document.parts.find((p) => p.id === partId)?.name ?? partId;

  // The bodies the bundle has at head.
  const theirs = new Map<string, Record<string, unknown>>();
  for (const item of list(bodiesList.items)) {
    const b = obj(item);
    if (typeof b.partId !== 'string' || typeof b.bodyId !== 'string') {
      add('The bundle lists a body without a part or body id.');
      continue;
    }
    if (b.change === 'deleted') continue;
    if (b.head === null || b.head === undefined) {
      if (b.change === 'added' || b.change === 'changed' || b.change === 'unchanged') {
        add(
          `${partName(b.partId)} / ${clip(text(b.name), 80)}: the bundle has no measurement at head${
            text(b.error) ? ` (${clip(text(b.error), 200)})` : ''
          }.`,
        );
      }
      continue;
    }
    theirs.set(`${b.partId}/${b.bodyId}`, b);
  }

  // The bodies this regen made.
  const ours = parts.flatMap((p) =>
    p.bodies.map((b) => ({
      partId: p.partId,
      bodyId: b.bodyId,
      creator: b.creator,
      viewId: b.view.id,
    })),
  );
  const ourKeys = new Set(ours.map((b) => `${b.partId}/${b.bodyId}`));
  for (const [key, b] of theirs) {
    if (!ourKeys.has(key)) {
      add(
        `${partName(text(b.partId))} / ${clip(text(b.name), 80)}: in the bundle, not in this regen.`,
      );
    }
  }
  const notInBundle = ours.filter((b) => !theirs.has(`${b.partId}/${b.bodyId}`));
  if (notInBundle.length > omittedBodies) {
    // More than the bundle can have left out: each is a difference.
    for (const b of notInBundle) {
      add(`${partName(b.partId)} / ${b.bodyId}: in this regen, not in the bundle.`);
    }
  } else if (notInBundle.length > 0) {
    unverified.push(
      `${notInBundle.length} ${notInBundle.length === 1 ? 'body' : 'bodies'} of this regen ${notInBundle.length === 1 ? 'is' : 'are'} not in the bundle, which left out ${omittedBodies} of its bodies: ${notInBundle.length === 1 ? 'it is' : 'they are'} not compared (${notInBundle
        .slice(0, 20)
        .map((b) => `${partName(b.partId)} / ${b.bodyId}`)
        .join(', ')}${notInBundle.length > 20 ? ', ...' : ''}).`,
    );
  }

  let compared = 0;
  for (const b of ours) {
    const their = theirs.get(`${b.partId}/${b.bodyId}`);
    if (!their) continue;
    const part = document.parts.find((p) => p.id === b.partId);
    const props = part?.bodies.find((x) => x.id === b.bodyId);
    const label = `${part?.name ?? b.partId} / ${clip(text(their.name), 80)}`;
    // The bundle names a body by its own name, else its creating feature's; inherited names (a
    // derived part's) are not known here, so those are not compared.
    const expectedName =
      props?.name ??
      (b.bodyId === b.creator ? part?.features.find((f) => f.id === b.creator)?.name : undefined);
    if (expectedName !== undefined && expectedName !== their.name) {
      add(`${label}: named "${clip(expectedName, 80)}" here.`);
    }
    const head = obj(their.head);
    const here = await input.measure(b.viewId);
    compared++;
    if (!here.ok) {
      add(`${label}: cannot be measured here (${clip(here.message, 200)}).`);
      continue;
    }
    const pairs: [string, unknown, number, string][] = [
      ['volume', head.volume, here.volume, 'mm³'],
      ['area', head.area, here.area, 'mm²'],
    ];
    for (const [what, a, ours, unit] of pairs) {
      const v = num(a);
      if (v === null || !close(v, ours)) {
        add(
          `${label}: ${what} ${v === null ? 'missing' : `${shownNumber(v)} ${unit}`} in the bundle, ${shownNumber(ours)} ${unit} here.`,
        );
      }
    }
    const box = head.boundingBox === null ? null : obj(head.boundingBox);
    if ((box === null) !== (here.boundingBox === null)) {
      add(
        `${label}: the bounding box is ${box === null ? 'missing in the bundle' : 'missing here'}.`,
      );
    } else if (box !== null && here.boundingBox !== null) {
      const theirBox = [...list(box.min), ...list(box.max)];
      const ourBox = [...here.boundingBox.min, ...here.boundingBox.max];
      const same =
        theirBox.length === 6 &&
        ourBox.length === 6 &&
        theirBox.every((x, i) => {
          const v = num(x);
          return v !== null && close(v, ourBox[i]!);
        });
      if (!same) {
        add(
          `${label}: bounding box ${theirBox.map((x) => shownNumber(num(x))).join(', ')} in the bundle, ${ourBox.map(shownNumber).join(', ')} here.`,
        );
      }
    }
    // Mass: from the material this document gives the body, where it gives one.
    const material = props?.material ?? part?.material;
    const found = material === undefined ? undefined : findMaterial(material);
    const theirMass = num(head.mass);
    if (found && theirMass !== null) {
      const mass = massGrams(here.volume, found.density);
      if (!close(theirMass, mass)) {
        add(
          `${label}: mass ${shownNumber(theirMass)} g in the bundle, ${shownNumber(mass)} g here.`,
        );
      }
    }
  }

  // Error codes of features at head, scripted features left out.
  const scripted = new Set(
    document.parts.flatMap((p) =>
      p.features.filter((f) => f.kind === 'scripted').map((f) => `${p.id}/${f.id}`),
    ),
  );
  const regen = obj(bundle.regen);
  const headIssues = [...list(obj(regen.new).items), ...list(obj(regen.remaining).items)];
  const omittedErrors = count(obj(regen.new).omitted) + count(obj(regen.remaining).omitted);
  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const theirErrors = tally(
    headIssues
      .map(obj)
      .filter(
        (e) =>
          e.where === 'feature' &&
          e.severity === 'error' &&
          typeof e.partId === 'string' &&
          typeof e.featureId === 'string' &&
          !scripted.has(`${e.partId}/${e.featureId}`),
      )
      .map((e) => `${text(e.partId)}/${text(e.featureId)}/${text(e.code)}`),
  );
  const ourErrors = tally(
    parts.flatMap((p) =>
      p.features
        .filter((f) => !scripted.has(`${p.partId}/${f.featureId}`) && f.kind !== 'scripted')
        .flatMap((f) => f.errors.map((e) => `${p.partId}/${f.featureId}/${e.code}`)),
    ),
  );
  const errorText = (key: string, a: number, b: number) => {
    const [partId, featureId, code] = key.split('/') as [string, string, string];
    const feature = document.parts
      .find((p) => p.id === partId)
      ?.features.find((f) => f.id === featureId);
    return `${partName(partId)} / ${clip(feature?.name ?? featureId, 80)}: error "${clip(code, 80)}" ${a} times in the bundle, ${b} here.`;
  };
  // An error the bundle lists more often than this regen has it is a difference, whatever it
  // left out; one this regen has more often may be among what the bundle left out.
  const extra: [string, number, number][] = [];
  let extraCount = 0;
  for (const key of new Set([...theirErrors.keys(), ...ourErrors.keys()])) {
    const a = theirErrors.get(key) ?? 0;
    const b = ourErrors.get(key) ?? 0;
    if (a > b) add(errorText(key, a, b));
    else if (b > a) {
      extra.push([key, a, b]);
      extraCount += b - a;
    }
  }
  if (extraCount > omittedErrors) {
    for (const [key, a, b] of extra) add(errorText(key, a, b));
  } else if (extraCount > 0) {
    unverified.push(
      `This regen has ${extraCount} feature ${extraCount === 1 ? 'error' : 'errors'} the bundle does not list, which left out ${omittedErrors} errors at head: ${extra
        .slice(0, 20)
        .map(([key, a, b]) => errorText(key, a, b))
        .join(' ')}${extra.length > 20 ? ' ...' : ''}`,
    );
  }
  if (scripted.size > 0) {
    notes.push(
      'Errors of scripted features are not compared: they depend on which scripts may run.',
    );
  }

  if (mismatches.length > MAX_MISMATCHES) {
    const more = mismatches.length - MAX_MISMATCHES;
    mismatches.length = MAX_MISMATCHES;
    mismatches.push(`and ${more} more differences`);
  }
  if (unverified.length > MAX_MISMATCHES) unverified.length = MAX_MISMATCHES;
  return { mismatches, unverified, notes, bodies: compared };
}

// Scripts -----------------------------------------------------------------------------------

/** A script as the Review view shows it: its source from the branch head, never the bundle's. */
export interface ShownScript {
  id: string;
  name: string;
  /** From the bundle's list (`added`, `changed`, `used`, `deleted`), else `unlisted`. */
  change: string;
  /** The source at head (at base for a deleted one, which no longer runs). */
  source: string;
  /** For a changed one, the source at base, as the bundle has it (it does not run). */
  previous: string | null;
  /** Hidden characters in `source` or `previous`, found here. */
  hiddenCharacters: boolean;
  /** The bundle's text of it is not what the branch head has. */
  differs: boolean;
}

export interface ScriptCheck {
  /** Every script on the branch head, the bundle's first, then any it does not list. */
  scripts: ShownScript[];
  /** Where the bundle's scripts are not the branch head's: approval waits for none. */
  mismatches: string[];
}

/**
 * The scripts the reviewer reads, from the branch head (`head`, as stored now) rather than from
 * the bundle, since **Run scripts** allows what the branch has: every script of the head, with
 * the bundle's change where it lists one, and where the bundle's source (or its start, when it
 * says it cut it) is not the head's, a mismatch. A script the bundle says was deleted shows the
 * bundle's text (it is not on the branch, so nothing runs it).
 */
export function branchScripts(bundle: ReviewBundle, head: ManufaktureDocument): ScriptCheck {
  const mismatches: string[] = [];
  const listed = list(bundle.scripts).map(obj);
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of listed) {
    if (typeof e.scriptId !== 'string') {
      mismatches.push('The bundle lists a script without an id.');
      continue;
    }
    byId.set(e.scriptId, e);
  }
  const headScripts = head.scripts ?? [];
  const onHead = new Set(headScripts.map((x) => x.id));
  const shown: ShownScript[] = [];
  const hidden = (a: string, b: string | null) =>
    hasHiddenCharacters(a) || (b !== null && hasHiddenCharacters(b));
  for (const script of headScripts) {
    const e = byId.get(script.id);
    const label = `Script ${clip(script.name, 80)}`;
    let differs = false;
    if (e !== undefined) {
      const theirs = text(e.source);
      differs =
        e.change === 'deleted' ||
        (e.truncated === true ? !script.source.startsWith(theirs) : theirs !== script.source);
      if (e.change === 'deleted') {
        mismatches.push(`${label}: the bundle says it was deleted, but the branch has it.`);
      } else if (differs) {
        mismatches.push(`${label}: the bundle shows a source other than the branch head’s.`);
      }
    }
    const previous = e !== undefined && typeof e.previous === 'string' ? e.previous : null;
    shown.push({
      id: script.id,
      name: script.name,
      change: e === undefined ? 'unlisted' : clip(text(e.change), 20),
      source: script.source,
      previous,
      hiddenCharacters: hidden(script.source, previous),
      differs,
    });
  }
  for (const e of listed) {
    if (typeof e.scriptId !== 'string' || onHead.has(e.scriptId)) continue;
    if (e.change !== 'deleted') {
      mismatches.push(`Script ${clip(text(e.name), 80)}: in the bundle, not on the branch head.`);
    }
    const source = text(e.source);
    shown.push({
      id: e.scriptId,
      name: text(e.name),
      change: e.change === 'deleted' ? 'deleted' : 'not on the branch',
      source,
      previous: null,
      hiddenCharacters: hidden(source, null),
      differs: e.change !== 'deleted',
    });
  }
  // The bundle's order first, then the head's scripts it does not list.
  const order = new Map(listed.map((e, i) => [text(e.scriptId), i]));
  shown.sort((a, b) => (order.get(a.id) ?? listed.length) - (order.get(b.id) ?? listed.length));
  return { scripts: shown, mismatches };
}

// The gate ----------------------------------------------------------------------------------

/** Where the comparison with this app's regen stands. */
export type RegenStatus =
  | { kind: 'not-open' }
  | { kind: 'waiting' }
  | { kind: 'edited' }
  | { kind: 'done'; check: RegenCheck };

/** The merge into Main as it would be made now. */
export type MergeStatus =
  | { kind: 'waiting' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; plan: Pick<MergePlan, 'applied' | 'dropped' | 'changed'> };

/**
 * Why **Approve** is not offered, or an empty list when it is: the branch is submitted, the
 * bundle reads and is not stale, its scripts are the branch head's, this app's regen of the head
 * matches it (and the reviewer acknowledged what the bundle left out and could not be compared),
 * and the merge into Main applies everything and changes something.
 *
 * `finishing`: the checks of **Finish approval**, for a branch already approved whose approval
 * was never recorded on Main (the tab closed in between): the branch must be approved instead,
 * and a merge that changes nothing passes (Main may already have it).
 */
export function approveBlockers(input: {
  state: string;
  review: LoadedReview;
  regen: RegenStatus;
  merge: MergeStatus;
  /** Where the bundle's scripts are not the branch head's (`branchScripts`). */
  scripts: readonly string[];
  /** The reviewer acknowledged `regen`'s `unverified`. */
  acknowledged: boolean;
  finishing?: boolean;
}): string[] {
  const out: string[] = [];
  const finishing = input.finishing === true;
  if (finishing ? input.state !== 'approved' : input.state !== 'submitted') {
    out.push(
      `The branch is not ${finishing ? 'approved' : 'submitted for review'} (${reviewStateText(input.state)}).`,
    );
  }
  const r = input.review;
  if (r.kind === 'none') out.push('The branch has no review bundle.');
  else if (r.kind === 'error') out.push(`The bundle cannot be read: ${r.message}`);
  else if (r.stale) out.push('The branch changed after its bundle was made.');
  if (input.scripts.length > 0) out.push('The bundle’s scripts are not the branch head’s.');
  switch (input.regen.kind) {
    case 'not-open':
      out.push('Open the branch so this app can regenerate it and compare.');
      break;
    case 'waiting':
      out.push('Comparing with this app’s regen...');
      break;
    case 'edited':
      out.push('The branch open here differs from its saved head.');
      break;
    case 'done':
      if (input.regen.check.mismatches.length > 0) {
        out.push('This app’s regen does not match the bundle.');
      } else if (input.regen.check.unverified.length > 0 && !input.acknowledged) {
        out.push('Acknowledge what the bundle left out and this app could not compare.');
      }
  }
  switch (input.merge.kind) {
    case 'waiting':
      out.push('Previewing the merge into Main...');
      break;
    case 'error':
      out.push(`It cannot be merged into Main: ${input.merge.message}`);
      break;
    case 'ready':
      if (input.merge.plan.dropped.length > 0) {
        out.push('Some of its changes would not apply on Main.');
      } else if (!input.merge.plan.changed && !finishing) {
        out.push('Main already has everything it changed.');
      }
  }
  return out;
}

/**
 * Whether a version of Main records the approval of agent branch `branch` (`ReviewReference`):
 * an approved branch none records was approved but never finished. Null when it cannot be told.
 */
export async function approvalRecorded(
  source: Pick<ReviewSource, 'listVersions'>,
  documentId: string,
  branch: string,
): Promise<boolean | null> {
  const r = await source.listVersions(documentId);
  if (!r.ok) return null;
  // A version from the sync server counts too: another device finished it.
  return r.value.some((v) => v.branch === undefined && v.review?.branch === branch);
}

/** The label of an approval's merge on Main: it names the session (at most 200 characters). */
export function approvalLabel(
  provenance: Pick<BranchProvenance, 'sessionId' | 'clientName'>,
): string {
  const head = `Approve agent session ${provenance.sessionId}`;
  const room = 200 - head.length - 3;
  if (room < 4) return head.slice(0, 200);
  return `${head} (${clip(provenance.clientName, room - 3).trim()})`;
}

/** The version recorded on Main after an approval. */
export const approvalVersionName = (branch: Pick<Branch, 'name'>): string =>
  clip(`Approved: ${branch.name}`, 190);
