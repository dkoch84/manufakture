import { describe, expect, it } from 'vitest';
import { compileDialect, normalizeCode, parseTemplateLine } from './dialect';
import type { Dialect } from './dialect';
import { testDialect } from './test-helpers';

function problem(d: unknown): string {
  const r = compileDialect(d);
  if (r.ok) throw new Error('expected the dialect to be refused');
  expect(r.error.code).toBe('invalid-dialect');
  return r.error.message;
}

function withTemplates(templates: Partial<Dialect['templates']>): Dialect {
  const base = testDialect();
  return testDialect({ templates: { ...base.templates, ...templates } });
}

describe('normalizeCode', () => {
  it('drops leading zeros and upper-cases', () => {
    expect(normalizeCode('G01', 'G')).toBe('G1');
    expect(normalizeCode('g00', 'G')).toBe('G0');
    expect(normalizeCode('G91.1', 'G')).toBe('G91.1');
    expect(normalizeCode('m30', 'M')).toBe('M30');
    expect(normalizeCode('M3', 'G')).toBeUndefined();
    expect(normalizeCode('G1 X2', 'G')).toBeUndefined();
  });
});

describe('compileDialect', () => {
  it('accepts a complete record, survives a JSON round trip, and normalises its codes', () => {
    const r = compileDialect(
      JSON.parse(
        JSON.stringify(testDialect({ gCodes: ['G00', 'G01', 'G2', 'G03', 'G17', 'G21', 'G90'] })),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.value.gCodes]).toEqual(['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'G90']);
    expect(r.value.templates.header[0]).toEqual({
      kind: 'comment',
      parts: [{ variable: 'job' }, ' / ', { variable: 'setup' }, ', ', { variable: 'date' }],
    });
  });

  it('refuses unknown and missing fields', () => {
    expect(problem({ ...testDialect(), script: 'x' })).toMatch(/Unknown field 'script'/);
    const noName: Record<string, unknown> = { ...testDialect() };
    delete noName.name;
    expect(problem(noName)).toMatch(/name/);
    expect(problem(null)).toMatch(/object/);
    expect(problem([])).toMatch(/object/);
  });

  it('checks the id, codes and required codes', () => {
    expect(problem(testDialect({ id: 'My Post' }))).toMatch(/id/);
    expect(problem(testDialect({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'X1'] }))).toMatch(
      /'X1'/,
    );
    expect(problem(testDialect({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G17', 'G21'] }))).toMatch(
      /needs G90/,
    );
    expect(problem(testDialect({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G17', 'G90'] }))).toMatch(
      /G21 or G20/,
    );
    expect(problem(testDialect({ mCodes: ['M3', 'M1x'] }))).toMatch(/'M1x'/);
  });

  it('checks the tool change style against the M codes', () => {
    expect(problem(testDialect({ toolChange: 'm6' }))).toMatch(/needs M6/);
    expect(problem(testDialect({ toolChange: 'm0-pause', mCodes: ['M3', 'M5'] }))).toMatch(
      /needs M0/,
    );
    expect(problem(testDialect({ toolChange: 'atc' as never }))).toMatch(/toolChange/);
    expect(
      compileDialect(testDialect({ toolChange: 'm6', mCodes: ['M3', 'M5', 'M6', 'M30'] })).ok,
    ).toBe(true);
  });

  it('checks flags, enums, the line length and the decimals', () => {
    expect(problem(testDialect({ splitPerTool: 'yes' as never }))).toMatch(/splitPerTool/);
    expect(problem(testDialect({ fullCircles: 'one' as never }))).toMatch(/fullCircles/);
    expect(problem(testDialect({ comments: 'semicolon' as never }))).toMatch(/comments/);
    expect(problem(testDialect({ maxLineLength: 20 }))).toMatch(/maxLineLength/);
    expect(problem(testDialect({ maxLineLength: 80.5 }))).toMatch(/maxLineLength/);
    expect(problem(testDialect({ dwellUnit: 'minutes' as never }))).toMatch(/dwellUnit/);
    const decimals = testDialect().decimals;
    expect(problem(testDialect({ decimals: { ...decimals, spindle: -1 } }))).toMatch(/decimals/);
    expect(
      problem(testDialect({ decimals: { ...decimals, mm: { coordinate: 7, feed: 0 } } })),
    ).toMatch(/decimals/);
    expect(
      problem(testDialect({ decimals: { ...decimals, mm: { coordinate: 1, feed: 0 } } })),
    ).toMatch(/at least 2/);
  });

  it('refuses unknown variables and template sections', () => {
    expect(problem(withTemplates({ header: ['({operator})'] }))).toMatch(
      /unknown variable \{operator\}/,
    );
    expect(problem(withTemplates({ header: ['({constructor})'] }))).toMatch(/unknown variable/);
    expect(
      problem({ ...testDialect(), templates: { ...testDialect().templates, start: [] } }),
    ).toMatch(/Unknown template section 'start'/);
    expect(problem(withTemplates({ footer: 'M30' as never }))).toMatch(/list of lines/);
  });

  it('keeps text variables out of code lines and code variables out of comments', () => {
    expect(problem(withTemplates({ header: ['G90 {tool_name}'] }))).toMatch(/only in a comment/);
    expect(problem(withTemplates({ header: ['({units_code})'] }))).toMatch(/only in a code line/);
    expect(compileDialect(withTemplates({ header: ['{units_code} G90'] })).ok).toBe(true);
  });

  it('allows settings in templates but no motion, distance mode or program end outside the footer', () => {
    expect(problem(withTemplates({ header: ['G0 Z10'] }))).toMatch(/may not write G0/);
    expect(problem(withTemplates({ header: ['G91'] }))).toMatch(/may not write G91/);
    expect(problem(withTemplates({ header: ['G90 X0'] }))).toMatch(/X word/);
    expect(problem(withTemplates({ header: ['M3 S1000'] }))).toMatch(/may not write M3/);
    expect(problem(withTemplates({ header: ['M30'] }))).toMatch(/only in the footer/);
    expect(problem(withTemplates({ header: ['T{tool}'] }))).toMatch(/only in the toolChange/);
    expect(problem(withTemplates({ header: ['G4'] }))).toMatch(/may not write G4/);
    expect(problem(withTemplates({ header: ['G54'] }))).toMatch(/not in the dialect's gCodes/);
    expect(problem(withTemplates({ header: ['P1'] }))).toMatch(/only with G64/);
    expect(
      compileDialect(withTemplates({ toolChange: ['T{tool}'], footer: ['M5', 'M30'] })).ok,
    ).toBe(true);
  });

  it('refuses malformed lines', () => {
    expect(problem(withTemplates({ header: ['(open'] }))).toMatch(/end with \)/);
    expect(problem(withTemplates({ header: ['(a (nested) b)'] }))).toMatch(/parentheses/);
    expect(problem(withTemplates({ header: ['G90 (inline)'] }))).toMatch(/comment, ; or %/);
    expect(problem(withTemplates({ header: ['G90 ; x'] }))).toMatch(/comment, ; or %/);
    expect(problem(withTemplates({ header: ['(café)'] }))).toMatch(/ASCII/);
    expect(problem(withTemplates({ header: [''] }))).toMatch(/empty/);
    expect(problem(withTemplates({ header: ['({job)'] }))).toMatch(/unbalanced/);
    expect(problem(withTemplates({ header: ['G90 G9O'] }))).toMatch(/words/);
  });
});

describe('compileDialect: words that would mislead the engine', () => {
  const gCodes = ['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'G54', 'G55', 'G64', 'G80', 'G90', 'G94'];
  const tpl = (section: 'header' | 'toolChange' | 'footer', line: string): Dialect =>
    testDialect({
      gCodes,
      templates: { header: [], tool: [], toolChange: [], footer: [], [section]: [line] },
    });

  it('refuses number variables glued to anything but T, and code variables glued at all', () => {
    expect(problem(tpl('toolChange', 'G{tool}'))).toMatch(/only as a tool number/);
    expect(problem(tpl('toolChange', 'M{tool}'))).toMatch(/only as a tool number/);
    expect(problem(tpl('header', 'G64 P{rpm}'))).toMatch(/only as a tool number/);
    expect(problem(tpl('header', 'G90 {file_index}'))).toMatch(/only as a tool number/);
    expect(problem(tpl('header', 'G9{units_code}'))).toMatch(/stand alone/);
    expect(compileDialect(tpl('toolChange', 'T{tool}')).ok).toBe(true);
    expect(compileDialect(tpl('header', '{units_code} G90')).ok).toBe(true);
  });

  it('allows a work offset only in the header', () => {
    expect(compileDialect(tpl('header', 'G54')).ok).toBe(true);
    expect(problem(tpl('toolChange', 'G55'))).toMatch(/only in the header/);
    expect(problem(tpl('footer', 'G54'))).toMatch(/only in the header/);
    expect(compileDialect(tpl('toolChange', 'G80')).ok).toBe(true);
  });

  it('needs one literal G64 P, greater than 0 and at most 0.1', () => {
    expect(problem(tpl('header', 'G64'))).toMatch(/exactly one P/);
    expect(problem(tpl('header', 'G64 P0.01 P0.02'))).toMatch(/exactly one P/);
    expect(problem(tpl('header', 'G64 P0'))).toMatch(/greater than 0/);
    expect(problem(tpl('header', 'G64 P0.5'))).toMatch(/at most 0.1/);
    expect(compileDialect(tpl('header', 'G64 P0.01')).ok).toBe(true);
  });

  it('returns an error value for input that is not plain data', () => {
    const hostile = {
      ...testDialect(),
      get id(): string {
        throw new Error('boom');
      },
    };
    expect(problem(hostile)).toMatch(/plain data/);
    const cyclic: Record<string, unknown> = { ...testDialect() };
    cyclic.self = cyclic;
    expect(problem(cyclic)).toMatch(/plain data/);
  });
});

describe('parseTemplateLine', () => {
  it('splits literals and variables', () => {
    expect(parseTemplateLine('M6 T{tool}')).toEqual({
      kind: 'code',
      parts: ['M6 T', { variable: 'tool' }],
    });
    expect(parseTemplateLine('  (Tool {tool})  ')).toEqual({
      kind: 'comment',
      parts: ['Tool ', { variable: 'tool' }],
    });
  });
});
