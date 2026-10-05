// Judges what collect.ts read against ADR 0006: every shipped package and manual entry has a
// license on the allowlist (LGPL only for a separate .wasm module, OFL only for fonts, MPL-2.0
// only without Exhibit B) and a license text to ship; our own packages are GPL-3.0-or-later;
// every bundled font file is listed with its hash. Pure, so it is unit tested (check.test.ts).

import type { Collected } from './collect.ts';
import {
  EXCEPTIONS,
  FONT,
  GPL3_COMPATIBLE,
  LGPL,
  MPL,
  OWN_LICENSE,
  PERMISSIVE,
  SEPARATE_MODULES,
} from './policy.ts';
import { evaluate, parseSpdx, SpdxSyntaxError, type LeafRule, type Verdict } from './spdx.ts';

/** Where a license is used, which decides what the allowlist admits. */
export interface UseContext {
  /** A separately loaded, replaceable `.wasm` module (decision 4): LGPL is allowed. */
  separateModule: boolean;
  /** A font file (the OFL amendment): OFL is allowed. */
  font: boolean;
  /** The files carry MPL's "Incompatible With Secondary Licenses" notice: MPL-2.0 is not allowed. */
  exhibitB: boolean;
}

export const PLAIN: UseContext = { separateModule: false, font: false, exhibitB: false };

/** The allowlist of ADR 0006 decisions 2 and 3 for one license id (and exception). */
export function allowlistRule(ctx: UseContext): LeafRule {
  return (id, exception) => {
    if (exception !== null) {
      const bases = EXCEPTIONS[exception];
      if (!bases) return `exception ${exception} is not on the allowlist`;
      if (!bases.includes(id)) return `exception ${exception} does not apply to ${id}`;
    }
    if (PERMISSIVE.has(id) || GPL3_COMPATIBLE.has(id)) return null;
    if (id === MPL) {
      return ctx.exhibitB
        ? 'MPL-2.0 files marked "Incompatible With Secondary Licenses" are not GPL-compatible'
        : null;
    }
    if (LGPL.has(id)) {
      return ctx.separateModule
        ? null
        : `${id} is allowed only for a separately loaded .wasm module (ADR 0006 decision 4)`;
    }
    if (FONT.has(id)) return ctx.font ? null : `${id} is allowed for font files only`;
    if (/^AGPL-/.test(id)) return `${id} is not allowed (ADR 0006 decision 3)`;
    if (id === 'GPL-2.0-only') return 'GPL-2.0-only is not compatible with GPLv3';
    return `${id} is not on the allowlist`;
  };
}

/** Judges an SPDX expression in a context; a string that is not SPDX is not allowed. */
export function judge(expression: string, ctx: UseContext = PLAIN): Verdict {
  try {
    return evaluate(parseSpdx(expression), allowlistRule(ctx));
  } catch (e) {
    if (e instanceof SpdxSyntaxError) {
      return { ok: false, reasons: [`not an SPDX expression (${e.message})`] };
    }
    throw e;
  }
}

/** Every reason the target may not ship as collected; empty when it may. */
export function check(collected: Collected): string[] {
  const problems: string[] = [];
  const target = collected.target.name;
  const shipped = new Set(collected.packages.map((p) => p.name));

  for (const m of collected.invalid) {
    problems.push(
      `${m.from} declares dependency ${JSON.stringify(m.name)}, which is not a valid npm package name`,
    );
  }
  for (const m of collected.missing) {
    problems.push(`${m.from} depends on ${m.name}, which is not installed (run pnpm install)`);
  }

  for (const w of collected.workspace) {
    if (w.license !== OWN_LICENSE) {
      problems.push(
        `${w.name} (${w.dir}) says license ${JSON.stringify(w.license)}, not ${OWN_LICENSE} (ADR 0006 decision 1)`,
      );
    }
  }

  for (const p of collected.packages) {
    const id = `${p.name}@${p.version}`;
    if (!p.license) {
      problems.push(`${id} (from ${p.via}) declares no license`);
    } else {
      const verdict = judge(p.license, {
        separateModule: SEPARATE_MODULES.has(p.name),
        font: false,
        exhibitB: p.exhibitB.length > 0,
      });
      if (!verdict.ok) {
        problems.push(
          `${id} (from ${p.via}): license "${p.license}": ${verdict.reasons.join('; ')}`,
        );
      }
    }
    const texts = [...p.licenseFiles, ...p.manualTexts];
    if (!texts.some((t) => t.text)) {
      problems.push(
        `${id} ships no license file; add its text to PACKAGE_TEXTS (tools/licenses/policy.ts)`,
      );
    }
    for (const t of p.manualTexts) {
      if (t.text === null) problems.push(`${id}: license text ${t.name} is missing`);
    }
  }

  for (const rule of collected.target.notShipped) {
    if (!collected.pruned.some((p) => p.package === rule.package)) {
      problems.push(
        `${target}: the not-shipped rule for ${rule.package} matched nothing; remove it from policy.ts`,
      );
    }
  }

  const listedFonts = new Map<string, string>();
  for (const { entry, texts } of collected.manual) {
    const name = `${entry.name} ${entry.version}`;
    const verdict = judge(entry.license, {
      separateModule: entry.inside.some((p) => SEPARATE_MODULES.has(p)),
      font: entry.kind === 'font',
      exhibitB: false,
    });
    if (!verdict.ok)
      problems.push(`${name}: license "${entry.license}": ${verdict.reasons.join('; ')}`);
    if (texts.length === 0) problems.push(`${name}: names no license text`);
    for (const t of texts) {
      if (t.text === null) problems.push(`${name}: license text ${t.name} is missing`);
    }
    if (entry.inside.length > 0 && !entry.inside.some((p) => shipped.has(p))) {
      problems.push(
        `${name}: none of the packages it is inside (${entry.inside.join(', ')}) ships with the ${target} target; remove or update the entry`,
      );
    }
    if (entry.kind === 'font') {
      if (!entry.files?.length) problems.push(`${name}: a font entry must list its files`);
      for (const f of entry.files ?? []) listedFonts.set(f.path, f.sha256);
    }
  }

  const found = new Map(collected.fonts.map((f) => [f.path, f.sha256]));
  for (const [path, sha256] of found) {
    const listed = listedFonts.get(path);
    if (listed === undefined) {
      problems.push(`font ${path} has no entry in MANUAL_ENTRIES (tools/licenses/policy.ts)`);
    } else if (listed !== sha256) {
      problems.push(
        `font ${path} has SHA-256 ${sha256}, not the ${listed} its entry records; a changed font needs its license read again (ADR 0011)`,
      );
    }
  }
  for (const path of listedFonts.keys()) {
    if (!found.has(path)) problems.push(`font ${path} is listed in MANUAL_ENTRIES but missing`);
  }

  return problems;
}
