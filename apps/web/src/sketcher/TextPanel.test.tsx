// The Text panel: it edits the selected text (string, font, size as an expression, alignment,
// spacing, angle), warns below the recommended size, and adds user fonts through the texter,
// showing what the font says about itself as plain text, never markup.

import {
  DEFAULT_UNITS,
  MAX_FONT_TOTAL_BYTES,
  MAX_IMPORT_BYTES,
  type DocumentFont,
} from '@manufakture/core';
import type { FontSummary } from '@manufakture/regen';
import { XY_PLANE } from '@manufakture/sketch/geometry';
import type { OutlineEntity, SketchEntity } from '@manufakture/sketch/model';
import { lengthQuantity } from '@manufakture/units';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSketchSession, type SketchSessionStore } from './session';
import { fontTotalProblem, millimetres, type Texter } from './text';
import { TextPanel } from './TextPanel';
import { immediateSolver } from './testSolver';

const BUNDLED: DocumentFont = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: { kind: 'bundled', id: 'inter-bold', sha256: 'f'.repeat(64) },
};

const TEXT: OutlineEntity = {
  id: 'e1',
  kind: 'outline',
  construction: false,
  anchor: [0, 0],
  angle: 0,
  source: {
    kind: 'text',
    text: 'OK',
    font: 'font#1',
    size: millimetres(6),
    align: { horizontal: 'center', vertical: 'middle' },
  },
};

const LINE: SketchEntity = {
  id: 'e2',
  kind: 'line',
  construction: false,
  start: [0, 0],
  end: [9, 0],
};

async function setup(entities: SketchEntity[] = [TEXT, LINE], texter: Texter | null = null) {
  const s = createSketchSession(immediateSolver().solver);
  s.getState().begin({
    featureId: 'sketch#1',
    isNew: true,
    name: 'Sketch 1',
    placement: XY_PLANE,
    entities,
    constraints: [],
    nextEntity: 3,
    nextConstraint: 1,
    units: DEFAULT_UNITS,
    variables: { label: lengthQuantity(3) },
    fonts: [BUNDLED],
    nextFont: 2,
  });
  await act(() => s.getState().idle());
  render(<TextPanel session={s} texter={texter} />);
  return s;
}

const text = (s: SketchSessionStore) =>
  s.getState().sketch.entities.find((e) => e.id === 'e1') as OutlineEntity;

function summary(patch: Partial<FontSummary> = {}): FontSummary {
  return {
    family: 'Hand',
    style: 'Regular',
    version: 'Version 1.0',
    copyright: 'Copyright 2020 Someone',
    license: 'Licensed under the SIL Open Font License',
    licenseUrl: 'https://example.org/ofl',
    fsType: 0,
    embedding: { level: 'installable', noSubsetting: false, bitmapOnly: false, restrictive: false },
    outlines: 'truetype',
    variable: false,
    glyphCount: 10,
    sha256: '',
    size: 8,
    ...patch,
  };
}

/** A font file's bytes: the TrueType signature and a little more. */
const TTF = new Uint8Array([0, 1, 0, 0, 9, 9, 9, 9]);

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fakeTexter(info: FontSummary | string) {
  return {
    outline: vi.fn(async () => null),
    readFont: vi.fn<Texter['readFont']>(async () =>
      typeof info === 'string'
        ? { ok: false as const, message: info }
        : { ok: true as const, info },
    ),
  } satisfies Texter;
}

function chooseFile(name: string, bytes: Uint8Array) {
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name);
  fireEvent.change(screen.getByTestId('add-font-file'), { target: { files: [file] } });
}

describe('the Text panel', () => {
  it('shows only while one text (or its anchor) is selected', async () => {
    const s = await setup();
    expect(screen.queryByTestId('text-panel')).toBeNull();
    act(() => s.getState().select({ kind: 'entity', id: 'e2' }));
    expect(screen.queryByTestId('text-panel')).toBeNull();
    act(() => s.getState().select({ kind: 'point', ref: { entity: 'e1', at: 'anchor' } }));
    expect(screen.getByTestId('text-panel').getAttribute('data-entity')).toBe('e1');
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    expect(screen.getByTestId('text-string')).toHaveProperty('value', 'OK');
  });

  it('edits the string as one undo step, and the alignment', async () => {
    const s = await setup();
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    const field = screen.getByTestId('text-string');
    for (const value of ['M', 'M3', 'M3 x 12']) fireEvent.change(field, { target: { value } });
    expect(text(s).source.text).toBe('M3 x 12');
    fireEvent.change(screen.getByTestId('text-align-h'), { target: { value: 'left' } });
    fireEvent.change(screen.getByTestId('text-align-v'), { target: { value: 'baseline' } });
    expect(text(s).source.align).toEqual({ horizontal: 'left', vertical: 'baseline' });
    act(() => s.getState().undo());
    act(() => s.getState().undo());
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    expect(text(s).source.text).toBe('M3 x 12');
    act(() => s.getState().undo());
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    expect(text(s).source.text).toBe('OK');
  });

  it('takes the size as an expression, keeps a value that does not evaluate out, and warns when small', async () => {
    const s = await setup();
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    const size = screen.getByTestId('text-size');
    fireEvent.change(size, { target: { value: '#label + 5' } });
    expect(text(s).source.size.source).toBe('#label + 5');
    expect(screen.queryByTestId('text-small')).toBeNull();
    fireEvent.change(size, { target: { value: '#nope' } });
    expect(text(s).source.size.source).toBe('#label + 5');
    expect(screen.getByTestId('text-size-error').textContent).toMatch(/nope/);
    fireEvent.change(size, { target: { value: '0' } });
    expect(text(s).source.size.source).toBe('#label + 5');
    fireEvent.change(size, { target: { value: '#label' } });
    expect(text(s).source.size.source).toBe('#label');
    // 3 mm: below the bundled font's recommended minimum of 4.2 mm.
    expect(screen.getByTestId('text-small').textContent).toMatch(/Below 4.2 mm/);
  });

  it('sets spacing and angle, and clears spacing back to none', async () => {
    const s = await setup();
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.change(screen.getByTestId('text-letter-spacing'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByTestId('text-line-spacing'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByTestId('text-angle'), { target: { value: '90' } });
    expect(text(s).source.letterSpacing?.source).toBe('0.5');
    expect(text(s).source.lineSpacing?.source).toBe('1.5');
    expect(text(s).angle).toBeCloseTo(Math.PI / 2, 12);
    fireEvent.change(screen.getByTestId('text-letter-spacing'), { target: { value: '' } });
    expect('letterSpacing' in text(s).source).toBe(false);
    fireEvent.change(screen.getByTestId('text-line-spacing'), { target: { value: '2 mm' } });
    expect(text(s).source.lineSpacing?.source).toBe('1.5');
  });

  it('shows the layout error and warnings of the text', async () => {
    const s = await setup();
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    act(() =>
      s.getState().setTextPreview('e1', {
        key: 'k',
        layout: null,
        error: 'This font could not be read (x.ttf): reading it took longer than 10000 ms',
        warnings: ['The font has no glyph for "一"; it is left out.'],
      }),
    );
    expect(screen.getByTestId('text-error').textContent).toMatch(/could not be read/);
    expect(screen.getByTestId('text-warning').textContent).toMatch(/no glyph/);
  });

  it('cannot add a font without a texter', async () => {
    const s = await setup();
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    expect(screen.getByTestId('text-add-font')).toHaveProperty('disabled', true);
  });
});

describe('Add font', () => {
  it('reads the file in the worker, shows its names and permissions, and uses it for the text', async () => {
    const info = summary({ sha256: await sha256(TTF), size: TTF.length });
    const texter = fakeTexter(info);
    const s = await setup(undefined, texter);
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('Hand.ttf', TTF);
    await screen.findByTestId('font-summary');
    expect(texter.readFont).toHaveBeenCalledTimes(1);
    expect(texter.readFont.mock.calls[0]![0]).toBe('Hand.ttf');
    expect(screen.getByTestId('font-family').textContent).toBe('Hand');
    expect(screen.getByTestId('font-license-url').textContent).toBe('https://example.org/ofl');
    expect(screen.getByTestId('font-embedding').textContent).toMatch(/^Installable/);
    expect(screen.queryByTestId('font-restrictive')).toBeNull();
    fireEvent.click(screen.getByTestId('add-font-ok'));
    await waitFor(() => expect(text(s).source.font).toBe('font#2'));
    const added = s.getState().addedFonts[0]!;
    expect(added).toMatchObject({
      id: 'font#2',
      family: 'Hand',
      style: 'Regular',
      source: {
        kind: 'file',
        fileName: 'Hand.ttf',
        size: 8,
        sha256: info.sha256,
        data: 'AAEAAAkJCQk=',
      },
    });
    expect(screen.queryByTestId('add-font')).toBeNull();
    expect(screen.getByTestId('text-font')).toHaveProperty('value', 'font#2');
  });

  it('renders what the font says as text, never markup, and warns of restrictive permissions', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const texter = fakeTexter(
      summary({
        family: hostile,
        copyright: hostile,
        licenseUrl: 'javascript:alert(3)',
        fsType: 2,
        embedding: {
          level: 'restricted',
          noSubsetting: false,
          bitmapOnly: false,
          restrictive: true,
        },
        sha256: await sha256(TTF),
      }),
    );
    const s = await setup(undefined, texter);
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('evil.ttf', TTF);
    const panel = await screen.findByTestId('font-summary');
    expect(screen.getByTestId('font-family').textContent).toBe(hostile);
    expect(panel.querySelector('img, script, a')).toBeNull();
    expect(screen.getByTestId('font-license-url').textContent).toBe('javascript:alert(3)');
    expect(screen.getByTestId('font-restrictive').textContent).toMatch(/restrictive/);
    expect(screen.getByTestId('font-embedding').textContent).toMatch(/^Restricted/);
  });

  it('refuses a file that is not a TTF or OTF font before anything reads it', async () => {
    const texter = fakeTexter(summary());
    const s = await setup(undefined, texter);
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('web.woff2', new TextEncoder().encode('wOF2xxxx'));
    expect((await screen.findByTestId('add-font-error')).textContent).toMatch(/WOFF/);
    chooseFile('page.ttf', new TextEncoder().encode('<html></html>'));
    await waitFor(() =>
      expect(screen.getByTestId('add-font-error').textContent).toBe(
        'The file is not a TrueType or OpenType font.',
      ),
    );
    expect(texter.readFont).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-font-ok')).toHaveProperty('disabled', true);
  });

  it('shows why the worker could not read the font, and adds nothing', async () => {
    const texter = fakeTexter(
      'This font could not be read (slow.otf): reading it took longer than 10000 ms',
    );
    const s = await setup(undefined, texter);
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('slow.otf', new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1]));
    expect((await screen.findByTestId('add-font-error')).textContent).toMatch(/longer than/);
    fireEvent.click(screen.getByTestId('add-font-cancel'));
    expect(screen.queryByTestId('add-font')).toBeNull();
    expect(s.getState().addedFonts).toEqual([]);
  });

  it("refuses a font that would take the document's fonts past their total", async () => {
    const texter = fakeTexter(summary({ sha256: await sha256(TTF) }));
    const s = await setup(undefined, texter);
    // Fonts already holding all but 4 bytes of MAX_FONT_TOTAL_BYTES.
    const sizes = [MAX_IMPORT_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_BYTES];
    sizes.push(MAX_FONT_TOTAL_BYTES - 3 * MAX_IMPORT_BYTES - 4);
    sizes.forEach((size, i) =>
      s.getState().addFont({
        family: `Big ${i}`,
        style: 'Regular',
        source: { kind: 'file', fileName: 'big.ttf', size, sha256: `${i}`.repeat(64), data: '' },
      }),
    );
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('Hand.ttf', TTF);
    expect((await screen.findByTestId('add-font-error')).textContent).toBe(
      "The document's fonts would hold 64.0 MiB; at most 64.0 MiB of fonts are allowed: delete a font first.",
    );
    expect(screen.getByTestId('add-font-ok')).toHaveProperty('disabled', true);
    expect(s.getState().addedFonts).toHaveLength(4);
    expect(fontTotalProblem([], TTF.length)).toBeNull();
  });

  it('ignores the reply for a file when another was chosen since', async () => {
    let release: () => void = () => undefined;
    const texter = {
      outline: vi.fn(async () => null),
      readFont: vi.fn<Texter['readFont']>((fileName) =>
        fileName === 'First.ttf'
          ? new Promise((resolve) => {
              release = () => resolve({ ok: true, info: summary({ family: 'First' }) });
            })
          : Promise.resolve({ ok: true as const, info: summary({ family: 'Second' }) }),
      ),
    } satisfies Texter;
    const s = await setup(undefined, texter);
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('First.ttf', TTF);
    await waitFor(() => expect(texter.readFont).toHaveBeenCalledTimes(1));
    chooseFile('Second.ttf', TTF);
    expect((await screen.findByTestId('font-family')).textContent).toBe('Second');
    await act(async () => release());
    expect(screen.getByTestId('font-family').textContent).toBe('Second');
    expect(screen.getByTestId('font-file').textContent).toMatch(/^Second\.ttf/);
  });

  it('offers the copy already in the document for the same file', async () => {
    const bytes = TTF;
    const sha = await sha256(bytes);
    const texter = fakeTexter(summary({ sha256: sha }));
    const s = await setup(undefined, texter);
    const existing = s.getState().addFont({
      family: 'Hand',
      style: 'Regular',
      source: { kind: 'file', fileName: 'Hand.ttf', size: 8, sha256: sha, data: 'AAEAAAkJCQk=' },
    });
    act(() => s.getState().select({ kind: 'entity', id: 'e1' }));
    fireEvent.click(screen.getByTestId('text-add-font'));
    chooseFile('copy.ttf', bytes);
    expect((await screen.findByTestId('add-font-twin')).textContent).toMatch(
      /already in the document/,
    );
    fireEvent.click(screen.getByTestId('add-font-ok'));
    await waitFor(() => expect(text(s).source.font).toBe(existing.id));
    expect(s.getState().addedFonts).toHaveLength(1);
  });
});
