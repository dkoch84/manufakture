// Fits as variables (ADR 0012 decision 10): the **Insert fit variables** command, which adds
// #fit_press, #fit_slip and #fit_sliding to the variables table in one batch (one undo step) and
// never overwrites a variable that is already there, and the helpers that offer those variables
// in fields where a clearance belongs (hole diameters, offsets). The values come from
// `@manufakture/print`'s fit table for the active print setup's printer and nozzle, or the
// generic defaults when the document has no print setup. They are placeholders until the fit-test
// coupon is printed and measured (docs/user/fits.md).

import {
  bareUnits,
  findPrintSetup,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type PrintSetup,
} from '@manufakture/core';
import {
  FIT_KINDS,
  FIT_VARIABLES,
  findPrinter,
  fitDefaults,
  type FitDefaults,
  type FitKind,
} from '@manufakture/print';
import { fromMillimetres } from '@manufakture/units';

/** Every fit variable name, without the `#`, tight to loose. */
export const FIT_VARIABLE_NAMES: readonly string[] = FIT_KINDS.map((k) => FIT_VARIABLES[k]);

/**
 * The print setup the fit values come from: `setupId` when given and present, else the
 * document's first setup (there is no active-setup choice outside the print workspace yet), or
 * none.
 */
export function fitSetup(doc: ManufaktureDocument, setupId?: string): PrintSetup | undefined {
  return (setupId ? findPrintSetup(doc, setupId) : undefined) ?? doc.print.setups[0];
}

/** The fit defaults for the document: from its print setup, or the generic ones. */
export function documentFitDefaults(doc: ManufaktureDocument, setupId?: string): FitDefaults {
  const setup = fitSetup(doc, setupId);
  return setup ? fitDefaults({ printer: setup.printer, nozzle: setup.nozzle }) : fitDefaults();
}

/** A clearance in mm as variable text: `0.2 mm`. */
export function clearanceSource(mm: number): string {
  return `${Number(mm.toFixed(3))} mm`;
}

export interface InsertFits {
  /** The batch to execute, or null when every fit variable is already in the table. */
  command: Command | null;
  label: string;
  /** Names added, and names left alone because they exist, without the `#`. */
  added: string[];
  kept: string[];
  defaults: FitDefaults;
  /** What happened, for the panel's status line. */
  message: string;
}

/**
 * Add the fit variables the table does not have yet, in one batch. Existing variables, whatever
 * their value, are kept as they are: the command never overwrites. Idempotent: a second run has
 * nothing to add and gives a null command.
 */
export function insertFitVariables(doc: ManufaktureDocument, setupId?: string): InsertFits {
  const defaults = documentFitDefaults(doc, setupId);
  const existing = new Set(doc.variables.map((v) => v.name));
  const added: string[] = [];
  const kept: string[] = [];
  const commands: Command[] = [];
  for (const kind of FIT_KINDS) {
    const name = FIT_VARIABLES[kind];
    if (existing.has(name)) {
      kept.push(name);
      continue;
    }
    added.push(name);
    commands.push({
      type: 'setVariable',
      name,
      expression: { source: clearanceSource(defaults.clearances[kind]), ...bareUnits(doc.units) },
    });
  }
  const label = 'Insert fit variables';
  if (commands.length === 0) {
    return {
      command: null,
      label,
      added,
      kept,
      defaults,
      message: 'The fit variables are already in the table; nothing was changed.',
    };
  }
  const setup = fitSetup(doc, setupId);
  const printer = setup ? (findPrinter(setup.printer)?.name ?? setup.printer) : null;
  const from = printer
    ? `for ${printer} with a ${defaults.nozzle} mm nozzle (${setup!.name})`
    : 'generic defaults: no print setup';
  const keptNote = kept.length > 0 ? ` Kept ${kept.map((n) => `#${n}`).join(', ')} as it was.` : '';
  return {
    command: { type: 'batch', commands },
    label,
    added,
    kept,
    defaults,
    message:
      `Added ${added.map((n) => `#${n}`).join(', ')}, ${from}. These are starting points: ` +
      `print the fit-test coupon to measure your own.${keptNote}`,
  };
}

/** `names` with the fit variables first (tight to loose), for fields where a clearance belongs. */
export function fitsFirst(names: readonly string[]): string[] {
  const fits = FIT_VARIABLE_NAMES.filter((n) => names.includes(n));
  return [...fits, ...names.filter((n) => !fits.includes(n))];
}

/** The fit a hole diameter written by `printedFitDiameter` uses, with its nominal text. */
export function parsePrintedFit(source: string): { nominal: string; fit: FitKind } | null {
  const m = /^\s*(.+?)\s*\+\s*#(fit_press|fit_slip|fit_sliding)\s*$/.exec(source);
  if (!m) return null;
  const fit = FIT_KINDS.find((k) => FIT_VARIABLES[k] === m[2])!;
  return { nominal: m[1]!, fit };
}

/**
 * A hole diameter for a pin or screw of `nominal` mm in a printed fit: `3 mm + #fit_slip`. The
 * nominal keeps five decimals in the display unit (M3 is `0.11811 in`), within 0.0002 mm of the
 * size, so the hole dialog finds the standard size again on edit.
 */
export function printedFitDiameter(nominal: number, fit: FitKind, units: DisplayUnits): string {
  const unit = bareUnits(units).lengthUnit;
  const value = Number(fromMillimetres(nominal, unit).toFixed(5));
  return `${value} ${unit} + #${FIT_VARIABLES[fit]}`;
}
