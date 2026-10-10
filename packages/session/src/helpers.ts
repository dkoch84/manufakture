// Session helpers (#1219): command types a session expands into ordinary core commands before the
// batch is resolved and applied, so an agent asks for what an app button does in one command
// while the branch's log, the review bundle and every replay hold only core commands. A helper
// is never stored: the batch saved is its expansion.
//
// `addConstructionSet` makes a construction drawing set, or one wall's framing elevation, as the
// app's "New construction set" button does (`constructionSetCommand` of the construction domain,
// the same code). It expands into an `addDrawing` (for a new drawing) and an `addSheet` and
// `addView` per sheet and view, plus a `deleteSheet` when an existing drawing's only sheet is
// still empty (the button's rule).
//
// Rules:
// - Helpers sit at the top level of a batch, anywhere among other commands; each is replaced where
//   it stands by its commands. One inside a nested `batch` is refused (`invalid-input`).
// - A helper reads the document as the batch found it: walls, roofs and drawings that earlier
//   commands of the same batch add or change are not seen. Make them in an earlier batch.
// - The sheets, views and new drawing a helper makes get symbolic ids (`sheet#$__set1s1`), so
//   real ids are handed out by the batch's symbol resolution like any other symbol: two helpers,
//   or a helper and the agent's own commands, never collide. These internal symbols are left out
//   of the batch report's `symbols`; a new drawing's id is in `created`, or under the agent's own
//   symbol when it gives one (`drawing: "drawing#$set"`). Agents may not write symbols with the
//   helpers' prefix (`__set`).
// - The batch after expansion holds at most `commandsPerBatch` commands. Each helper is given what
//   the batch has left and refused (`too-many-commands`) as soon as its planned sheets and views
//   pass it, before they are built. The document-wide reads (variables, construction settings,
//   part studios and drawings by id) are done once per batch, and each part's walls once.
// - Text copied from the document into the expansion (wall, level and document names, a copied
//   title block) goes through symbol resolution like the agent's own text: a wall named like a
//   symbol (`e$__set1s1`) can make the helper's batch refused ("written with two counters"). It
//   never changes an id.

import {
  SHEET_SIZES,
  type Command,
  type Drawing,
  type ManufaktureDocument,
  type Measurement,
  type Sheet,
} from '@manufakture/core';
import {
  MAX_SET_NAME,
  MAX_WALL_POINTS,
  buildingOf,
  clipSetName,
  constructionSetCommand,
  setReads,
  setVariables,
  type SetReads,
} from '@manufakture/domain-construction';
import { z } from 'zod';

/** The prefix of the symbols helpers make: the batch report leaves them out. */
export const HELPER_SYMBOL_PREFIX = '__set';

const Id = z.string().min(1).max(200);

/** `addConstructionSet`: get_schema's schema of it, and its check. */
export const AddConstructionSetSchema = z
  .strictObject({
    type: z.literal('addConstructionSet'),
    part: Id.describe('The part studio whose walls, roofs and levels are drawn.'),
    drawing: Id.optional().describe(
      "An existing drawing to add the sheets to (its only sheet gives way when it is still empty), or a symbolic id (drawing#$set) for a new drawing. Absent: a new drawing, its id in the report's created ids.",
    ),
    name: z
      .string()
      .min(1)
      .max(MAX_SET_NAME)
      .optional()
      .describe(
        'A new drawing\'s name. Default: "Construction set", or "Framing: <wall name>" with wall.',
      ),
    wall: Id.optional().describe(
      "Only this wall's framing elevation: one sheet with a view per segment. Absent: the whole set (a plan per level, the four building elevations, a framing elevation sheet per wall, a roof framing plan per roof).",
    ),
    segment: z
      .int()
      .min(1)
      .max(MAX_WALL_POINTS)
      .optional()
      .describe("With wall: only this segment's view (1-based)."),
    size: z.enum(SHEET_SIZES).optional().describe('The sheets\' size. Default "tabloid".'),
    orientation: z.enum(['landscape', 'portrait']).optional().describe('Default "landscape".'),
    planScale: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        'The plans\' and building elevations\' scale: "auto" (default: the largest that fits) or one of 1/2" = 1\', 3/8" = 1\', 1/4" = 1\', 3/16" = 1\', 1/8" = 1\', 3/32" = 1\', 1/16" = 1\' (feet and inches documents) or 1:20, 1:25, 1:50, 1:100, 1:200, 1:500 (metric ones).',
      ),
    framingScale: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('The same, for framing elevations and roof framing plans.'),
  })
  .describe(
    "A session helper, not a core command: makes a construction drawing set, or one wall's framing elevation, as the app's Construction set button does. The session expands it into addDrawing, addSheet, addView (and deleteSheet) commands before applying the batch, so the log holds those. It reads the document as the batch found it. It goes at the top level of a batch, never inside a nested batch.",
  );

export type AddConstructionSet = z.infer<typeof AddConstructionSetSchema>;

/** The helper command types, for the schema index. */
export const HELPER_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map([
  ['addConstructionSet', AddConstructionSetSchema],
]);

/** Each command in `commands` and in its nested batches (bounded by `batchProblem` before). */
function* walk(commands: readonly unknown[]): Generator<{ c: unknown; nested: boolean }> {
  const lists: [readonly unknown[], boolean][] = [[commands, false]];
  while (lists.length > 0) {
    const [list, nested] = lists.pop()!;
    for (const c of list) {
      const o = c as { type?: unknown; commands?: unknown } | null;
      if (o !== null && typeof o === 'object' && o.type === 'batch' && Array.isArray(o.commands)) {
        lists.push([o.commands, true]);
        continue;
      }
      yield { c, nested };
    }
  }
}

const isHelper = (c: unknown) =>
  HELPER_SCHEMAS.has((c as { type?: unknown } | null)?.type as never);

/** Whether a batch's commands hold a helper, at any depth. */
export function hasHelpers(commands: readonly unknown[]): boolean {
  for (const { c } of walk(commands)) if (isHelper(c)) return true;
  return false;
}

/**
 * A symbol an agent writes with the helpers' prefix (`sheet#$__set1s1`): refused, so a helper's
 * symbols never meet the agent's and the report can leave them out. The pattern is the symbol
 * pattern of `symbols.ts` (`TOKEN`), run on each string as resolution runs it.
 */
const RESERVED_SYMBOL = new RegExp(
  `(?<![A-Za-z0-9_#$])(?:[a-z][a-zA-Z0-9]*#|[ekr])\\$${HELPER_SYMBOL_PREFIX}[A-Za-z0-9_]{0,59}(?![A-Za-z0-9_$])`,
);

/** Why the agent's batch writes a reserved symbol, or null. Walks every string, no recursion. */
export function reservedSymbolProblem(commands: readonly unknown[]): string | null {
  const values: unknown[] = [commands];
  while (values.length > 0) {
    const v = values.pop();
    if (typeof v === 'string') {
      const m = RESERVED_SYMBOL.exec(v);
      if (m !== null) {
        return `Symbols starting with ${HELPER_SYMBOL_PREFIX} are kept for session helpers: rename ${m[0]}.`;
      }
    } else if (v !== null && typeof v === 'object') {
      for (const x of Array.isArray(v) ? v : Object.values(v)) values.push(x);
    }
  }
  return null;
}

/** A symbolic drawing id (`drawing#$name`): a new drawing. */
const SYMBOLIC_DRAWING = /^drawing#\$[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type ExpandProblem = {
  ok: false;
  code: 'invalid-input' | 'too-many-commands';
  message: string;
  limit?: number;
};

/**
 * `commands` with each top-level helper replaced by its core commands, made against `doc` (the
 * document before the batch); `measurements` are what variables that measure the model read.
 * The batch's commands after expansion are kept within `maxCommands`: each helper gets what the
 * batch has left, checked before its sheets and views are built, so a refused batch costs at most
 * one helper's plan past the limit. Errors name the helper by its place in the batch. `symbols`
 * are the symbols the helpers made (`$__set1s1`), for the report to leave out.
 */
export function expandHelpers(
  doc: ManufaktureDocument,
  commands: readonly unknown[],
  maxCommands: number,
  measurements: readonly Measurement[] = [],
): { ok: true; commands: unknown[]; symbols: Set<string> } | ExpandProblem {
  // The batch's own commands, at any depth; a helper anywhere but the top level is refused.
  let count = 0;
  for (const { c, nested } of walk(commands)) {
    if (!isHelper(c)) {
      count++;
      continue;
    }
    if (nested) {
      const type = (c as { type: string }).type;
      return {
        ok: false,
        code: 'invalid-input',
        message: `${type} is a session helper: put it at the top level of the batch, not inside a nested batch.`,
      };
    }
  }
  const out: unknown[] = [];
  const symbols = new Set<string>();
  let n = 0;
  // Read from the whole document once per batch, whatever the helpers name: the variables, the
  // construction settings and the part studios (`setReads`), and the drawings by id.
  let variables: ReturnType<typeof setVariables> | undefined;
  let reads: SetReads | undefined;
  let drawings: ReadonlyMap<string, Drawing> | undefined;
  const buildings = new Map<string, ReturnType<typeof buildingOf>>();
  // Existing drawings whose empty only sheet an earlier helper of the batch already replaced.
  const replaced = new Set<string>();
  // Drawing ids earlier commands of the batch make (`addDrawing`, or a helper's new drawing).
  const madeEarlier = new Set<string>();
  const tooMany = (): ExpandProblem => ({
    ok: false,
    code: 'too-many-commands',
    message: `A batch holds at most ${maxCommands} commands, and its helpers expand it past that. Make the set in parts (one wall per command) or over several batches.`,
    limit: maxCommands,
  });
  for (const [i, raw] of commands.entries()) {
    const type = (raw as { type?: unknown } | null)?.type;
    if (type !== 'addConstructionSet') {
      out.push(raw);
      for (const { c } of walk([raw])) {
        const o = c as { type?: unknown; drawing?: { id?: unknown } } | null;
        if (o?.type === 'addDrawing' && typeof o.drawing?.id === 'string') {
          madeEarlier.add(o.drawing.id);
        }
      }
      continue;
    }
    const where = `Command ${i + 1} (addConstructionSet)`;
    const parsed = AddConstructionSetSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const path = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      return { ok: false, code: 'invalid-input', message: `${where}: ${issue.message}${path}.` };
    }
    const h = parsed.data;
    if (h.drawing !== undefined && madeEarlier.has(h.drawing)) {
      return {
        ok: false,
        code: 'invalid-input',
        message: `${where}: ${h.drawing} is made earlier in this batch, and a helper reads the document as the batch found it. Add the sheets to it in a later batch, or let this helper make the drawing.`,
      };
    }
    n += 1;
    const sym = `${HELPER_SYMBOL_PREFIX}${n}`;
    variables ??= setVariables(doc, measurements);
    // The part's walls are read once per batch: every later helper on it costs only its own walls.
    let building = buildings.get(h.part);
    if (building === undefined) {
      reads ??= setReads(doc);
      building = buildingOf(doc, h.part, variables, reads);
      buildings.set(h.part, building);
    }
    let drawing: Drawing;
    let like: Sheet | undefined;
    const before: Command[] = [];
    const existing =
      h.drawing === undefined
        ? undefined
        : (drawings ??= new Map((doc.drawings ?? []).map((d) => [d.id, d]))).get(h.drawing);
    if (existing) {
      like = existing.sheets[0];
      drawing = replaced.has(existing.id) ? { ...existing, sheets: [] } : existing;
      replaced.add(existing.id);
    } else {
      if (h.drawing !== undefined && !SYMBOLIC_DRAWING.test(h.drawing)) {
        return {
          ok: false,
          code: 'invalid-input',
          message: `${where}: there is no drawing ${h.drawing}; give a symbolic id (drawing#$set) for a new one.`,
        };
      }
      const wall =
        h.wall === undefined || !building.ok ? undefined : building.building.byId.get(h.wall);
      const name = h.name ?? clipSetName(wall ? `Framing: ${wall.name}` : 'Construction set');
      const id = h.drawing ?? `drawing#$${sym}`;
      if (h.drawing === undefined) symbols.add(`$${sym}`);
      madeEarlier.add(id);
      drawing = { id, name, sheets: [], nextIds: {} };
      before.push({ type: 'addDrawing', drawing });
    }
    const budget = maxCommands - count - before.length;
    if (budget <= 0) return tooMany();
    let sheets = 0;
    let views = 0;
    const made = constructionSetCommand(
      doc,
      drawing,
      like,
      {
        part: h.part,
        size: h.size ?? 'tabloid',
        orientation: h.orientation ?? 'landscape',
        planScale: h.planScale ?? 'auto',
        framingScale: h.framingScale ?? 'auto',
        ...(h.wall === undefined ? {} : { wall: h.wall }),
        ...(h.segment === undefined ? {} : { segment: h.segment }),
      },
      {
        variables,
        building,
        budget,
        ids: {
          sheets: (k) => {
            sheets = k;
            return Array.from({ length: k }, (_, j) => `sheet#$${sym}s${j + 1}`);
          },
          views: (k) => {
            views = k;
            return Array.from({ length: k }, (_, j) => `view#$${sym}v${j + 1}`);
          },
        },
      },
    );
    if (!made.ok) {
      return made.tooMany
        ? tooMany()
        : { ok: false, code: 'invalid-input', message: `${where}: ${made.message}` };
    }
    for (let j = 1; j <= sheets; j++) symbols.add(`$${sym}s${j}`);
    for (let j = 1; j <= views; j++) symbols.add(`$${sym}v${j}`);
    const expanded = (made.command as { commands: Command[] }).commands;
    count += before.length + expanded.length;
    out.push(...before, ...expanded);
  }
  return { ok: true, commands: out, symbols };
}

/** `table` without the symbols the helpers made (`made`, from `expandHelpers`). */
export function withoutHelperSymbols(
  table: Record<string, string>,
  made: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) if (!made.has(k)) out[k] = v;
  return out;
}
