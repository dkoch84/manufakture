// The verifier's parser ships no types; its declarations live with the cam package's post tests.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../../packages/cam/src/post/gcode-toolpath.d.ts" />
// The export's logic: default settings from the setup and machine, what has to be generated or
// fixed first, the job written by each post in each multi-tool mode (checked with the G-code
// verifier, T5.4d), the summary and setup sheet data (every tool change, grouping warnings), the
// refusals, and the saved files (one G-code file, or a zip for one file per tool).

import {
  CARBIDE_MOTION_DIALECT,
  GRBLHAL_DIALECT,
  GRBL_DIALECT,
  type Dialect,
  type ToolChangeStyle,
} from '@manufakture/cam';
import { findMachine } from '@manufakture/cam/library';
import type { CamOperation } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { verifyGcode } from '../../../../../packages/cam/test/verify-gcode';
import type { GeneratedOutcome } from '../status';
import {
  buildExport,
  defaultExportSettings,
  exportFiles,
  exportReadiness,
  formatFeed,
  formatLength,
  formatSize,
  groupingWarnings,
  multiToolModes,
  originText,
  withPost,
  type ExportPlan,
  type ExportSettings,
} from './export';
import { DOC_OPERATIONS, STOCK_WCS, exportGeneration, flat, vbit } from './export.test-fixture';
import { setupSheetHtml } from './sheet';

const machine = findMachine('shapeoko-5-pro-4x4')!;
const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  post: 'carbide-motion',
  units: 'mm',
  multiTool: 'm6',
  groupByTool: false,
  ...over,
});

function plan(over: Partial<ExportSettings> = {}, data = exportGeneration()): ExportPlan {
  const r = buildExport({
    data,
    operations: DOC_OPERATIONS,
    settings: settings(over),
    jobName: 'Sign',
    setupName: 'Top',
    machine,
    date: '2026-10-02',
  });
  if (!r.ok) throw new Error(r.reasons.join('\n'));
  return r.plan;
}

function verify(text: string, dialect: Dialect, toolChange: ToolChangeStyle, tools = [flat]) {
  const report = verifyGcode(text, {
    dialect,
    toolChange,
    stock: STOCK_WCS,
    machine: { travel: [machine.travel.x.value, machine.travel.y.value, machine.travel.z.value] },
    tools,
  });
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.issues).toEqual([]);
  return report.value;
}

describe('export settings', () => {
  it("start from the setup's post, else the machine's default, with the post's first mode", () => {
    expect(defaultExportSettings({ post: 'carbide-motion' }, machine)).toEqual({
      post: 'carbide-motion',
      units: 'mm',
      multiTool: 'm6',
      groupByTool: false,
    });
    expect(defaultExportSettings({ post: 'grbl' }, machine).multiTool).toBe('files');
    // A post this version does not write: the machine's default (Carbide Motion on a Shapeoko).
    expect(defaultExportSettings({ post: 'my-post' }, machine).post).toBe('carbide-motion');
  });

  it('keep the multi-tool mode across posts only when the new post writes it', () => {
    const grbl = settings({ post: 'grbl', multiTool: 'pause' });
    expect(withPost(grbl, 'grblhal').multiTool).toBe('pause');
    expect(withPost(grbl, 'carbide-motion').multiTool).toBe('m6');
    expect(withPost(withPost(grbl, 'linuxcnc'), 'grbl').multiTool).toBe('files');
    expect(multiToolModes('grbl')).toEqual(['files', 'pause']);
    expect(multiToolModes('constructor')).toEqual([]);
  });
});

describe('exportReadiness', () => {
  const op = (id: string, suppressed = false): CamOperation =>
    ({ id, name: `Op ${id}`, kind: 'facing', suppressed }) as unknown as CamOperation;
  const geometry = (errors: Record<string, string> = {}): CamGeometryResult =>
    ({
      setupId: 'setup#1',
      status: 'ok',
      errors: [],
      operations: ['a', 'b', 'c'].map((id) => ({
        operationId: id,
        key: `k-${id}`,
        status: errors[id] ? 'error' : 'ok',
        errors: errors[id] ? [{ code: 'expression', message: errors[id] }] : [],
        warnings: [],
      })),
    }) as unknown as CamGeometryResult;
  const outcome = (key: string, ok = true, message?: string): GeneratedOutcome => ({
    key,
    ok,
    warnings: [],
    ...(message ? { message } : {}),
  });
  const toolpaths = (ids: string[]) =>
    ({
      setupId: 'setup#1',
      operations: ids.map((id) => ({ id, ok: true })),
    }) as unknown as Parameters<typeof exportReadiness>[3];
  const setup = { id: 'setup#1', operations: [op('a'), op('b'), op('c', true)] };

  it('is ready when every active operation was generated from its current inputs', () => {
    const generated = new Map([
      ['a', outcome('k-a')],
      ['b', outcome('k-b')],
    ]);
    expect(exportReadiness(setup, geometry(), generated, toolpaths(['a', 'b']), true)).toEqual({
      blocked: [],
      stale: [],
      message: null,
      pending: false,
    });
  });

  it("counts every active operation as pending while the geometry is not the current document's", () => {
    // Generated and up to date by their keys, but the document changed since the geometry came:
    // an edit to the stock or the feeds may have changed any of them.
    const generated = new Map([
      ['a', outcome('k-a')],
      ['b', outcome('k-b', false, 'An old failure.')],
    ]);
    const r = exportReadiness(setup, geometry(), generated, toolpaths(['a', 'b']), true, false);
    expect(r).toEqual({ blocked: [], stale: ['a', 'b'], message: null, pending: true });
    expect(
      exportReadiness(setup, geometry(), generated, toolpaths(['a']), false, false).message,
    ).toMatch(/kernel/);
  });

  it('lists operations never generated or generated from inputs that changed since', () => {
    const generated = new Map([['a', outcome('old-key')]]);
    const r = exportReadiness(setup, geometry(), generated, toolpaths(['a']), true);
    expect(r.stale).toEqual(['a', 'b']);
    expect(r.blocked).toEqual([]);
    // No geometry stage here: nothing can generate them.
    expect(exportReadiness(setup, null, new Map(), null, false).message).toMatch(/kernel/);
  });

  it('blocks on an error in the geometry or in the last generation, naming the operation', () => {
    const generated = new Map([
      ['a', outcome('k-a', false, 'The tool does not fit inside the profile.')],
      ['b', outcome('k-b')],
    ]);
    const r = exportReadiness(
      setup,
      geometry({ b: 'Unknown variable #width' }),
      generated,
      toolpaths(['b']),
      true,
    );
    expect(r.blocked).toEqual([
      { id: 'a', name: 'Op a', message: 'The tool does not fit inside the profile.' },
      { id: 'b', name: 'Op b', message: 'Unknown variable #width' },
    ]);
  });

  it('says so when there is nothing to export', () => {
    const none = { id: 'setup#1', operations: [op('c', true)] };
    expect(exportReadiness(none, null, new Map(), null, true).message).toMatch(/suppressed/);
  });
});

describe('buildExport', () => {
  it('writes one Carbide Motion file with an M6 at every tool change, which verifies', () => {
    const p = plan();
    expect(p.files.map((f) => f.name)).toEqual(['Sign - Top.nc']);
    expect(p.postName).toBe('Carbide Motion');
    const report = verify(p.files[0]!.text, CARBIDE_MOTION_DIALECT, 'm6', [flat, vbit]);
    expect(report.toolChanges).toBe(3);
    expect(p.files[0]!.text).toMatch(/^M6 T201$/m);
    expect(p.files[0]!.text).toContain('(Zero X, Y and Z at: stock top, front left corner)');
    // The router dial comment from the machine's Compact Router.
    expect(p.files[0]!.text).toContain('Router dial 4: 24500 rpm, nearest to 24000 rpm');
  });

  it('writes Grbl files per tool (named in order) or one file with M0 pauses, which verify', () => {
    const files = plan({ post: 'grbl', multiTool: 'files' });
    expect(files.files.map((f) => f.name)).toEqual([
      'Sign - Top - 1 of 3 - #201 1_4_ flat.nc',
      'Sign - Top - 2 of 3 - #302 60 deg V-bit.nc',
      'Sign - Top - 3 of 3 - #201 1_4_ flat.nc',
    ]);
    verify(files.files[0]!.text, GRBL_DIALECT, 'none', [flat]);
    verify(files.files[1]!.text, GRBL_DIALECT, 'none', [vbit]);
    verify(files.files[2]!.text, GRBL_DIALECT, 'none', [flat]);
    expect(files.toolChanges.map((c) => c.file)).toEqual([1, 2, 3]);

    const pause = plan({ post: 'grbl', multiTool: 'pause' });
    expect(pause.files).toHaveLength(1);
    verify(pause.files[0]!.text, GRBL_DIALECT, 'm0-pause', [flat, vbit, flat]);
    expect(pause.toolChanges.map((c) => c.file)).toEqual([1, 1, 1]);
    expect(pause.warnings.join(' ')).toMatch(/does not jog while held by an M0/);

    const hal = plan({ post: 'grblhal', multiTool: 'm6' });
    verify(hal.files[0]!.text, GRBLHAL_DIALECT, 'm6', [flat, vbit]);
  });

  it('writes inches with G20 when asked', () => {
    const p = plan({ units: 'inch' });
    expect(p.files[0]!.text).toMatch(/^G20 /m);
    verify(p.files[0]!.text, CARBIDE_MOTION_DIALECT, 'm6', [flat, vbit]);
  });

  it('lists every tool change, the tools in order of use, and each operation with depths', () => {
    const p = plan();
    expect(p.toolChanges.map((c) => [c.index, c.tool.number, c.operation, c.rpm])).toEqual([
      [1, 201, 'Clean', 18000],
      [2, 302, 'Recess', 24000],
      [3, 201, 'Outline', 18000],
    ]);
    expect(p.tools.map((t) => [t.number, t.operations])).toEqual([
      [201, ['Clean', 'Outline']],
      [302, ['Recess']],
    ]);
    expect(p.operations.map((o) => [o.name, o.zTop, o.zBottom, o.through, o.stepdown])).toEqual([
      ['Clean', 0, -1, false, 1],
      ['Recess', 0, -2, false, 1],
      ['Outline', 0, -10, true, 1],
    ]);
    expect(p.operations.every((o) => o.minutes !== null && o.minutes > 0)).toBe(true);
    expect(p.stock.size).toEqual([100, 60, 10]);
    expect(p.stock.box).toEqual(STOCK_WCS);
    expect(p.origin.text).toBe('stock top, front left corner');
    expect(p.extents.feed!.min[2]).toBe(-10);
    expect(p.stats!.estimate.totalMinutes).toBeGreaterThan(0);
    expect(p.warnings).toEqual([]);
  });

  it('groups by tool on request, warning when a through-cut moves ahead of another cut', () => {
    const p = plan({ groupByTool: true });
    expect(p.toolChanges.map((c) => c.operation)).toEqual(['Clean', 'Recess']);
    expect(p.operations.map((o) => o.name)).toEqual(['Clean', 'Outline', 'Recess']);
    expect(p.warnings).toEqual([
      'Grouping by tool runs Outline, which cuts through the stock, before Recess: the part may come loose before it is finished.',
    ]);
  });

  it('refuses, with the reason, when an operation has an error', () => {
    const r = buildExport({
      data: exportGeneration({ failed: 'pocket#2' }),
      operations: DOC_OPERATIONS,
      settings: settings(),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    expect(r).toEqual({
      ok: false,
      reasons: ['Recess: The tool does not fit inside the profile.'],
    });
    // Suppressed, it is left out and the rest exports.
    const suppressed = DOC_OPERATIONS.map((o) =>
      o.id === 'pocket#2' ? { ...o, suppressed: true } : o,
    );
    const ok = buildExport({
      data: exportGeneration({ failed: 'pocket#2' }),
      operations: suppressed,
      settings: settings(),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    expect(ok.ok && ok.plan.toolChanges.map((c) => c.operation)).toEqual(['Clean']);
  });

  it('refuses an operation of the document missing from the generation', () => {
    const r = buildExport({
      data: exportGeneration(),
      operations: [...DOC_OPERATIONS, { id: 'drill#1', name: 'Holes', suppressed: false }],
      settings: settings(),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    expect(r).toEqual({ ok: false, reasons: ['Holes: its geometry did not resolve.'] });
  });

  it("follows the document's list: its order, and without operations deleted since", () => {
    const r = buildExport({
      data: exportGeneration(),
      operations: [DOC_OPERATIONS[2]!, DOC_OPERATIONS[0]!],
      settings: settings(),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    if (!r.ok) throw new Error(r.reasons.join('\n'));
    expect(r.plan.operations.map((o) => o.name)).toEqual(['Outline', 'Clean']);
    expect(r.plan.toolChanges).toHaveLength(1);
    expect(r.plan.files[0]!.text).not.toContain('(Recess)');
  });

  it("refuses with the post's reason when the post cannot write the job", () => {
    const { number: _n, ...unnumbered } = flat;
    void _n;
    const r = buildExport({
      data: exportGeneration({ tools: { flat: unnumbered } }),
      operations: DOC_OPERATIONS,
      settings: settings(),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons[0]).toMatch(/^The Carbide Motion post refuses the job: /);
    // Grbl writes no T word, so the same job goes out as files per tool.
    const grbl = buildExport({
      data: exportGeneration({ tools: { flat: unnumbered } }),
      operations: DOC_OPERATIONS,
      settings: settings({ post: 'grbl', multiTool: 'files' }),
      jobName: 'Sign',
      setupName: 'Top',
      machine,
      date: '2026-10-02',
    });
    expect(grbl.ok).toBe(true);
  });
});

describe('groupingWarnings', () => {
  const op = (id: string, tool: string, through = false) => ({
    id,
    name: id,
    tool: { id: tool },
    through,
  });
  it('warns only when grouping puts a through-cut before a cut that came first', () => {
    expect(groupingWarnings([op('a', 't1', true), op('b', 't2'), op('c', 't1')])).toEqual([]);
    expect(groupingWarnings([op('a', 't1'), op('b', 't2'), op('c', 't1', true)])).toHaveLength(1);
    expect(groupingWarnings([op('a', 't1'), op('b', 't1', true)])).toEqual([]);
  });
});

describe('exportFiles', () => {
  it('saves one G-code file as it is', () => {
    const p = plan();
    const files = exportFiles(p, setupSheetHtml(p));
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('Sign - Top.nc');
    expect(files[0]!.type).toBe('text/plain');
    expect(strFromU8(files[0]!.bytes)).toBe(p.files[0]!.text);
  });

  it('saves files per tool as one zip, with the setup sheet', () => {
    const p = plan({ post: 'grbl', multiTool: 'files' });
    const sheet = setupSheetHtml(p);
    const files = exportFiles(p, sheet);
    expect(files.map((f) => [f.name, f.type])).toEqual([['Sign - Top.zip', 'application/zip']]);
    const entries = unzipSync(files[0]!.bytes);
    expect(Object.keys(entries)).toEqual([
      ...p.files.map((f) => f.name),
      'Sign - Top - setup sheet.html',
    ]);
    expect(strFromU8(entries[p.files[1]!.name]!)).toBe(p.files[1]!.text);
    expect(strFromU8(entries['Sign - Top - setup sheet.html']!)).toBe(sheet);
  });
});

describe('formatting', () => {
  it('writes lengths, feeds and sizes in the export units', () => {
    expect(formatLength(12.5, 'mm')).toBe('12.5 mm');
    expect(formatLength(-0.001, 'mm')).toBe('0 mm');
    expect(formatLength(25.4, 'inch')).toBe('1 in');
    expect(formatFeed(1500, 'mm')).toBe('1500 mm/min');
    expect(formatFeed(1500, 'inch')).toBe('59.1 in/min');
    expect(formatSize([100, 60, 10], 'mm')).toBe('100 x 60 x 10 mm');
    expect(originText({ xy: 'centre', z: 'bottom' })).toBe('stock bottom, centre');
  });
});
