import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_UNITS, type DisplayUnits } from '@manufakture/core';
import { XY_PLANE } from '@manufakture/sketch/geometry';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSketchSession } from './session';
import { SketchToolbar } from './SketchMode';
import { TextPanel } from './TextPanel';
import { immediateSolver } from './testSolver';

/** Issues the mocked `parseSvg` adds to every file, for the dialog's cap on what it lists. */
const extra = vi.hoisted(() => ({ issues: 0 }));
vi.mock('@manufakture/io', async (original) => {
  const io = await original<typeof import('@manufakture/io')>();
  return {
    ...io,
    parseSvg: (text: string) => {
      const parsed = io.parseSvg(text);
      const more = Array.from({ length: extra.issues }, (_, i) => ({
        code: 'attribute' as const,
        message: `Made-up issue ${i}.`,
      }));
      return { ...parsed, issues: [...parsed.issues, ...more] };
    },
  };
});

const LETTERS = readFileSync(
  join(import.meta.dirname, '../../../../packages/io/src/fixtures/svg/letters.svg'),
  'utf8',
);

async function setup(units: DisplayUnits = DEFAULT_UNITS) {
  const fake = immediateSolver();
  const s = createSketchSession(fake.solver);
  s.getState().begin({
    featureId: 'sketch#1',
    isNew: true,
    name: 'Sketch 1',
    placement: XY_PLANE,
    entities: [],
    constraints: [],
    nextEntity: 1,
    nextConstraint: 1,
    units,
    variables: {},
  });
  await act(() => s.getState().idle());
  render(<SketchToolbar session={s} onFinish={() => {}} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import SVG' }));
  return s;
}

async function choose(text: string, name = 'letters.svg') {
  const input = screen.getByTestId('svg-import-file');
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File([text], name, { type: 'image/svg+xml' })] },
    });
  });
}

describe('Import SVG', () => {
  it('imports the file as one outline by default, with its scale stored', async () => {
    const s = await setup();
    expect(screen.getByTestId('svg-import-mode')).toHaveProperty('value', 'outline');
    await choose(LETTERS);
    await waitFor(() => screen.getByTestId('svg-import-summary'));
    expect(screen.getByTestId('svg-import-counts').textContent).toBe('4 shapes as one outline');
    expect(screen.getByTestId('svg-import-size').textContent).toMatch(/^110(\.0+)? mm$/);
    fireEvent.change(screen.getByTestId('svg-import-scale'), { target: { value: '0.5' } });
    expect(screen.getByTestId('svg-import-size').textContent).toMatch(/^55(\.0+)? mm$/);
    fireEvent.change(screen.getByTestId('svg-import-x'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('svg-import-ok'));
    await act(() => s.getState().idle());
    const { sketch, message } = s.getState();
    expect(sketch.entities).toHaveLength(1);
    const e = sketch.entities[0]!;
    expect(e.kind === 'outline' && e.anchor).toEqual([10, 0]);
    expect(e.kind === 'outline' && e.source.kind === 'svg' && e.source.fileName).toBe(
      'letters.svg',
    );
    expect(e.kind === 'outline' && e.source.kind === 'svg' && e.source.scale?.source).toBe('0.5');
    expect(message).toBe('Imported letters.svg as one outline.');
    s.getState().undo();
    expect(s.getState().sketch.entities).toEqual([]);
  });

  it('reads a file, shows what it makes, and imports it into the sketch as one edit', async () => {
    const s = await setup();
    expect(screen.getByRole('dialog', { name: 'Import SVG' })).toBeTruthy();
    expect(screen.getByTestId('svg-import-ok')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('svg-import-mode'), { target: { value: 'entities' } });
    await choose(LETTERS);
    await waitFor(() => screen.getByTestId('svg-import-summary'));
    expect(screen.getByTestId('svg-import-name').textContent).toBe('letters.svg');
    expect(screen.getByTestId('svg-import-counts').textContent).toMatch(
      /^\d+ lines, \d+ arcs and 1 circle$/,
    );
    // The artwork is 110 mm wide (6 to 116 in the file), within the arcs' tolerance.
    expect(screen.getByTestId('svg-import-size').textContent).toMatch(/^110(\.0+)? mm$/);
    fireEvent.change(screen.getByTestId('svg-import-scale'), { target: { value: '0.5' } });
    expect(screen.getByTestId('svg-import-size').textContent).toMatch(/^55(\.0+)? mm$/);
    fireEvent.change(screen.getByTestId('svg-import-anchor'), { target: { value: 'center' } });
    fireEvent.change(screen.getByTestId('svg-import-x'), { target: { value: '100' } });
    fireEvent.change(screen.getByTestId('svg-import-y'), { target: { value: '-20' } });
    fireEvent.click(screen.getByTestId('svg-import-ok'));
    await act(() => s.getState().idle());

    expect(screen.queryByTestId('svg-import')).toBeNull();
    const { sketch, selection, message, canUndo } = s.getState();
    expect(sketch.entities.length).toBeGreaterThan(40);
    expect(sketch.constraints).toEqual([]);
    expect(selection).toHaveLength(sketch.entities.length);
    expect(message).toMatch(/^Imported .* from letters\.svg, unconstrained\.$/);
    expect(canUndo).toBe(true);
    // Centred on (100, -20) at half size.
    const circle = sketch.entities.find((e) => e.kind === 'circle')!;
    expect(circle.kind === 'circle' && circle.radius).toBeCloseTo(2, 9);
    s.getState().undo();
    expect(s.getState().sketch.entities).toEqual([]);
  });

  it('takes lengths in the document units, and lines only', async () => {
    const s = await setup({ ...DEFAULT_UNITS, length: { unit: 'in', decimals: 3 } });
    fireEvent.change(screen.getByTestId('svg-import-mode'), { target: { value: 'entities' } });
    await choose(LETTERS);
    await waitFor(() => screen.getByTestId('svg-import-summary'));
    expect(screen.getByTestId('svg-import-size').textContent).toBe('4.331"');
    fireEvent.change(screen.getByTestId('svg-import-x'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('svg-import-curves'), { target: { value: 'lines' } });
    expect(screen.getByTestId('svg-import-counts').textContent).toMatch(/^\d+ lines and 1 circle$/);
    fireEvent.click(screen.getByTestId('svg-import-ok'));
    await act(() => s.getState().idle());
    const xs = s.getState().sketch.entities.flatMap((e) => (e.kind === 'line' ? [e.start[0]] : []));
    expect(Math.min(...xs)).toBeCloseTo(25.4, 1);
    expect(s.getState().sketch.entities.some((e) => e.kind === 'arc')).toBe(false);
  });

  it('says what is wrong with a field or a file, and keeps Import off', async () => {
    await setup();
    fireEvent.change(screen.getByTestId('svg-import-scale'), { target: { value: '-1' } });
    expect(screen.getByText('Scale: The scale must be above 0.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('svg-import-scale'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('svg-import-mode'), { target: { value: 'entities' } });

    fireEvent.change(screen.getByTestId('svg-import-tolerance'), { target: { value: '5 mm' } });
    expect(screen.getByText(/tolerance must be between/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('svg-import-tolerance'), { target: { value: '0.02' } });
    await choose('<svg><g></svg>', 'broken.svg');
    await waitFor(() => screen.getByTestId('svg-import-error'));
    expect(screen.getByTestId('svg-import-error').textContent).toMatch(/not well-formed XML/);
    expect(screen.getByTestId('svg-import-ok')).toHaveProperty('disabled', true);
    await choose('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>', 'text.svg');
    await waitFor(() =>
      expect(screen.getByTestId('svg-import-error').textContent).toBe(
        'The file has no shapes to import.',
      ),
    );
  });

  it('refuses a drawing the sketch solver could not hold, and suggests lines', async () => {
    await setup();
    fireEvent.change(screen.getByTestId('svg-import-mode'), { target: { value: 'entities' } });

    const uses = Array.from({ length: 4 }, (_, i) => `<use href="#l" x="${i * 130}"/>`).join('');
    const inner = LETTERS.replace(/^[\s\S]*?<g id="letters"[^>]*>/, '').replace(
      /<\/g>\s*<\/svg>\s*$/,
      '',
    );
    await choose(
      `<svg xmlns="http://www.w3.org/2000/svg" width="520mm" height="50mm" viewBox="0 0 520 50"><defs><g id="l">${inner}</g></defs>${uses}</svg>`,
    );
    await waitFor(() => screen.getByTestId('svg-import-too-much'));
    expect(screen.getByTestId('svg-import-too-much').textContent).toMatch(/import curves as lines/);
    expect(screen.getByTestId('svg-import-ok')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('svg-import-curves'), { target: { value: 'lines' } });
    expect(screen.queryByTestId('svg-import-too-much')).toBeNull();
    expect(screen.getByTestId('svg-import-ok')).toHaveProperty('disabled', false);
  });

  it('closes on Cancel and on Escape', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('svg-import-cancel'));
    expect(screen.queryByTestId('svg-import')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import SVG' }));
    fireEvent.keyDown(screen.getByTestId('svg-import-scale'), { key: 'Escape' });
    expect(screen.queryByTestId('svg-import')).toBeNull();
  });

  it('edits an imported outline: its scale (an expression) and its angle, in the panel', async () => {
    const s = await setup();
    await choose(LETTERS);
    await waitFor(() => screen.getByTestId('svg-import-summary'));
    fireEvent.click(screen.getByTestId('svg-import-ok'));
    await act(() => s.getState().idle());
    render(<TextPanel session={s} texter={null} />);
    expect(screen.getByTestId('svg-outline-panel').getAttribute('data-entity')).toBe('e1');
    expect(screen.getByTestId('svg-outline-file').textContent).toBe('letters.svg: 4 shapes');
    fireEvent.change(screen.getByTestId('svg-outline-scale'), { target: { value: '2 * 1.5' } });
    const e = s.getState().sketch.entities[0]!;
    expect(e.kind === 'outline' && e.source.kind === 'svg' && e.source.scale?.source).toBe(
      '2 * 1.5',
    );
    fireEvent.change(screen.getByTestId('svg-outline-scale'), { target: { value: '' } });
    const cleared = s.getState().sketch.entities[0]!;
    expect(
      cleared.kind === 'outline' && cleared.source.kind === 'svg' && cleared.source.scale,
    ).toBe(undefined);
    fireEvent.change(screen.getByTestId('svg-outline-angle'), { target: { value: '90' } });
    const turned = s.getState().sketch.entities[0]!;
    expect(turned.kind === 'outline' && turned.angle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('lists at most 8 issues, then says how many more there are', async () => {
    extra.issues = 20;
    try {
      await setup();
      await choose(LETTERS);
      await waitFor(() => screen.getByTestId('svg-import-summary'));
      const notes = screen.getAllByRole('note').filter((n) => /Made-up issue/.test(n.textContent!));
      expect(notes).toHaveLength(8);
      expect(screen.getByTestId('svg-import-more-issues').textContent).toBe('And 12 more.');
    } finally {
      extra.issues = 0;
    }
  });
});
