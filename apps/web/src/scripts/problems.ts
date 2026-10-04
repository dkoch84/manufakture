// What regen reported about a script, for the editor's markers and its list of problems: every
// scripted feature that runs the script and failed because of it, with the 1-based line and column
// regen mapped back to the source as written (TypeScript included). "Scripts not run" is not a
// problem of the script; the banner covers it.

import type { ManufaktureDocument } from '@manufakture/core';
import type { RegenError } from '@manufakture/regen';
import type { PartModel } from '../model/model';

export interface ScriptProblem {
  partId: string;
  featureId: string;
  /** "Part 1 / Scripted 1", or the feature's name when the document has one part. */
  where: string;
  /** `ScriptError.code`: `runtime`, `syntax`, `timeout`, `bad-param` and the others. */
  code: string;
  message: string;
  line?: number;
  column?: number;
}

type ScriptRegenError = Extract<RegenError, { code: 'script' }>;

function isScriptError(e: { code: string }): e is ScriptRegenError {
  return e.code === 'script';
}

/** The problems regen reported for script `scriptId` of `doc`, in part and feature order. */
export function scriptProblems(
  doc: ManufaktureDocument,
  parts: readonly PartModel[],
  scriptId: string,
): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  for (const part of doc.parts) {
    const results = parts.find((p) => p.partId === part.id)?.features ?? [];
    for (const f of part.features) {
      if (f.kind !== 'scripted' || f.script !== scriptId) continue;
      const result = results.find((r) => r.featureId === f.id);
      for (const e of result?.errors ?? []) {
        if (!isScriptError(e) || e.scriptId !== scriptId || e.scriptCode === 'not-allowed') {
          continue;
        }
        const p: ScriptProblem = {
          partId: part.id,
          featureId: f.id,
          where: doc.parts.length > 1 ? `${part.name} / ${f.name}` : f.name,
          code: e.scriptCode,
          message: e.message,
        };
        if (e.line !== undefined) p.line = e.line;
        if (e.column !== undefined) p.column = e.column;
        out.push(p);
      }
    }
  }
  return out;
}

/** "line 3, column 5", "line 3", or "" when regen gave no position. */
export function positionText(p: { line?: number; column?: number }): string {
  if (p.line === undefined) return '';
  return p.column === undefined ? `line ${p.line}` : `line ${p.line}, column ${p.column}`;
}
