// The setup sheet: stock, work zero and how to set it, the tools with numbers, every tool change
// in order (the first tool loaded included), and per operation its depths and feeds; text from
// the document is escaped.

import { findMachine } from '@manufakture/cam/library';
import { describe, expect, it } from 'vitest';
import {
  buildExport,
  escapeHtml,
  setupSheetHtml,
  zeroingSteps,
  type ExportPlan,
  type ExportSettings,
} from '@manufakture/cam/export';
import { DOC_OPERATIONS, exportGeneration } from './export.test-fixture';

const machine = findMachine('shapeoko-5-pro-4x4')!;

function plan(over: Partial<ExportSettings> = {}, jobName = 'Sign'): ExportPlan {
  const r = buildExport({
    data: exportGeneration(),
    operations: DOC_OPERATIONS,
    settings: { post: 'carbide-motion', units: 'mm', multiTool: 'm6', groupByTool: false, ...over },
    jobName,
    setupName: 'Top',
    machine,
    date: '2026-10-02',
    source: { id: 'main' },
  });
  if (!r.ok) throw new Error(r.reasons.join('\n'));
  return r.plan;
}

/** The sheet parsed, for queries. */
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('setupSheetHtml', () => {
  it('lists every tool change in order, with its tool number, operation and speed', () => {
    const doc = parse(setupSheetHtml(plan()));
    const changes = [...doc.querySelectorAll('[data-sheet="tool-changes"] li')].map(
      (li) => li.textContent,
    );
    expect(changes).toEqual([
      'Load T201 #201 1/4" flat for Clean: 18000 rpm; Router dial 3: 18250 rpm, nearest to 18000 rpm',
      'Change to T302 #302 60 deg V-bit for Recess: 24000 rpm; Router dial 4: 24500 rpm, nearest to 24000 rpm',
      'Change to T201 #201 1/4" flat for Outline: 18000 rpm; Router dial 3: 18250 rpm, nearest to 18000 rpm',
    ]);
    expect(doc.querySelector('h2:nth-of-type(4)')?.textContent).toBe('Tool changes (3)');
  });

  it('names the file of each change when the job is one file per tool', () => {
    const doc = parse(setupSheetHtml(plan({ post: 'grbl', multiTool: 'files' })));
    const changes = [...doc.querySelectorAll('[data-tool-change]')].map((li) => li.textContent);
    expect(changes.map((c) => c!.match(/\(file \d of \d\)/)?.[0])).toEqual([
      '(file 1 of 3)',
      '(file 2 of 3)',
      '(file 3 of 3)',
    ]);
    expect(doc.querySelectorAll('[data-sheet="files"] li')).toHaveLength(3);
  });

  it('gives the stock, the work zero, the tools and each operation with depths and feeds', () => {
    const doc = parse(setupSheetHtml(plan()));
    const stock = doc.querySelector('[data-sheet="stock"]')!.textContent!;
    expect(stock).toContain('100 x 60 x 10 mm');
    expect(stock).toContain('plywood');
    expect(stock).toContain('stock top, front left corner');
    const tools = [...doc.querySelectorAll('[data-sheet="tools"] tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(tools).toEqual([
      ['T201', '#201 1/4" flat', '6.35 mm', '2', 'Clean, Outline'],
      ['T302', '#302 60 deg V-bit', '12.7 mm', '2', 'Recess'],
    ]);
    const outline = doc.querySelector('[data-operation="profile#1"]')!;
    const cells = [...outline.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells.slice(0, 6)).toEqual([
      '3',
      'Outline (Profile) through',
      'T201 #201 1/4" flat',
      '0 mm',
      '-10 mm',
      '1 mm',
    ]);
    expect(cells[7]).toBe('1000 mm/min');
    expect(cells[8]).toBe('300 mm/min');
    const inch = parse(setupSheetHtml(plan({ units: 'inch' })));
    expect(inch.querySelector('[data-sheet="stock"]')!.textContent).toContain(
      '3.937 x 2.362 x 0.394 in',
    );
  });

  it('says how to zero, and how tool changes go for the chosen mode', () => {
    const m6 = zeroingSteps(plan());
    expect(m6).toContain(
      'Jog the tool tip over the front left corner of the stock (its smallest X and Y) and zero X and Y there.',
    );
    expect(m6).toContain('Zero Z with the tool tip touching the top of the stock.');
    expect(m6.at(-1)).toMatch(/^Carbide Motion stops at each M6 .* BitSetter as standard/);
    expect(zeroingSteps(plan({ post: 'grbl', multiTool: 'files' })).at(-1)).toMatch(
      /^The job is 3 files, one per tool: run them in order/,
    );
    expect(zeroingSteps(plan({ post: 'grbl', multiTool: 'pause' })).at(-1)).toMatch(
      /^At each M0 pause: .* Grbl does not jog while held by an M0/,
    );
    expect(zeroingSteps(plan({ post: 'linuxcnc', multiTool: 'm6' })).at(-1)).toMatch(
      /^Each M6 asks for the next tool/,
    );
  });

  it('escapes text from the document', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
    );
    const html = setupSheetHtml(plan({}, 'Sign <script>alert(1)</script>'));
    expect(html).not.toContain('<script>');
    expect(parse(html).querySelector('h1')!.textContent).toBe(
      'Setup sheet: Sign <script>alert(1)</script> - Top',
    );
  });
});
