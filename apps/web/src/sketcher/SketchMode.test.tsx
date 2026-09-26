import { DEFAULT_UNITS } from '@manufakture/core';
import { XY_PLANE } from '@manufakture/sketch/geometry';
import type { SketchConstraint, SketchEntity } from '@manufakture/sketch/model';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PointerDelegate } from '../viewport/engine';
import type { ViewportApi } from '../viewport/Viewport';
import { createSketchSession, type SketchSessionStore } from './session';
import { ConflictPanel, SketchCanvas, SketchStatusBar, SketchToolbar } from './SketchMode';
import { useSketchShortcuts } from './shortcuts';
import { immediateSolver } from './testSolver';

// A camera looking down on XY: 10 px per mm, the sketch origin at (200, 200).
function fakeViewport() {
  let delegate: PointerDelegate | null = null;
  const api = {
    projectToCanvas: ([x, y]: readonly [number, number, number]) => ({
      x: 200 + 10 * x,
      y: 200 - 10 * y,
    }),
    canvasToPlane: (x: number, y: number) =>
      [(x - 200) / 10, (200 - y) / 10, 0] as [number, number, number],
    onViewChange: vi.fn(() => () => {}),
    setPointerDelegate: vi.fn((d: PointerDelegate | null) => (delegate = d)),
    info: () => ({ size: { width: 400, height: 400 } }),
  };
  return { api: api as unknown as ViewportApi, raw: api, delegate: () => delegate };
}

const RECT: SketchEntity[] = [
  { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [10, 0] },
  { id: 'e2', kind: 'line', construction: false, start: [10, 0], end: [10, 5] },
];
const CONSTRAINTS: SketchConstraint[] = [
  { id: 'k1', kind: 'horizontal', line: 'e1' },
  { id: 'k2', kind: 'vertical', line: 'e2' },
  {
    id: 'k3',
    kind: 'distance',
    a: { entity: 'e1', at: 'start' },
    b: { entity: 'e1', at: 'end' },
    value: { source: '10', lengthUnit: 'mm', angleUnit: 'deg' },
  },
];

async function session(diagnosis = {}, entities = RECT, constraints = CONSTRAINTS) {
  const fake = immediateSolver(diagnosis);
  const s = createSketchSession(fake.solver);
  s.getState().begin({
    featureId: 'sketch#1',
    isNew: true,
    name: 'Sketch 1',
    placement: XY_PLANE,
    entities,
    constraints,
    nextEntity: 3,
    nextConstraint: 4,
    units: DEFAULT_UNITS,
    variables: {},
  });
  await act(() => s.getState().idle());
  return { s, fake };
}

function renderCanvas(s: SketchSessionStore) {
  const vp = fakeViewport();
  const view = render(
    <SketchCanvas session={s} viewport={vp.api} size={{ width: 400, height: 400 }} />,
  );
  return { vp, view };
}

describe('the sketch overlay', () => {
  it('draws geometry coloured by its constraint state, with glyphs and dimensions', async () => {
    const { s } = await session({ dof: 1, entities: { e1: 'fully', e2: 'under' } });
    renderCanvas(s);
    expect(screen.getByTestId('entity-e1').getAttribute('data-status')).toBe('fully');
    expect(screen.getByTestId('entity-e2').getAttribute('data-status')).toBe('under');
    expect(screen.getByTestId('entity-e1').getAttribute('d')).toBe('M200.0 200.0L300.0 200.0');
    expect(screen.getByTestId('constraint-k1').textContent).toBe('H');
    expect(screen.getByTestId('constraint-k2').getAttribute('title')).toBe('Vertical (k2)');
    expect(screen.getByTestId('dimension-k3').textContent).toBe('10.00 mm');
  });

  it('selects a constraint from its glyph', async () => {
    const { s } = await session();
    renderCanvas(s);
    fireEvent.click(screen.getByTestId('constraint-k2'));
    expect(s.getState().selection).toEqual([{ kind: 'constraint', id: 'k2' }]);
    fireEvent.click(screen.getByTestId('constraint-k1'), { ctrlKey: true });
    expect(s.getState().selection).toHaveLength(2);
    expect(screen.getByTestId('constraint-k1').className).toContain('selected');
  });

  it('edits a dimension in place, refusing text that is not a length', async () => {
    const { s } = await session();
    renderCanvas(s);
    fireEvent.doubleClick(screen.getByTestId('dimension-k3'));
    const input = screen.getByTestId('dimension-input') as HTMLInputElement;
    expect(input.value).toBe('10');
    fireEvent.change(input, { target: { value: '45deg' } });
    expect(screen.getByTestId('dimension-error').textContent).toMatch(/length/i);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('dimension-input')).toBeDefined();

    fireEvent.change(input, { target: { value: '1/2"' } });
    expect(screen.getByTestId('dimension-preview').textContent).toBe('= 12.70 mm');
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(() => s.getState().idle());
    expect(screen.queryByTestId('dimension-input')).toBeNull();
    const k3 = s.getState().sketch.constraints.find((c) => c.id === 'k3')!;
    expect(k3).toMatchObject({ value: { source: '1/2"', lengthUnit: 'mm' } });
    expect(screen.getByTestId('dimension-k3').textContent).toBe('1/2" = 12.70 mm');
  });

  it('names glyphs and dimension labels for assistive technology', async () => {
    const { s } = await session({ conflicting: ['k2'] });
    renderCanvas(s);
    expect(screen.getByRole('button', { name: 'Horizontal constraint k1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Vertical constraint k2, conflicting' })).toBe(
      screen.getByTestId('constraint-k2'),
    );
    expect(screen.getByRole('button', { name: 'Distance dimension 10.00 mm' })).toBe(
      screen.getByTestId('dimension-k3'),
    );
  });

  it('gives the keyboard back to the 3D view when the dimension box closes', async () => {
    const { s } = await session();
    const vp = fakeViewport();
    render(
      <div className="viewport">
        <canvas data-testid="canvas" tabIndex={0} />
        <SketchCanvas session={s} viewport={vp.api} size={{ width: 400, height: 400 }} />
      </div>,
    );
    fireEvent.doubleClick(screen.getByTestId('dimension-k3'));
    const input = screen.getByTestId('dimension-input');
    input.focus();
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(() => s.getState().idle());
    expect(screen.queryByTestId('dimension-input')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('canvas'));
    // Esc too.
    screen.getByTestId('canvas').blur();
    fireEvent.doubleClick(screen.getByTestId('dimension-k3'));
    screen.getByTestId('dimension-input').focus();
    fireEvent.keyDown(screen.getByTestId('dimension-input'), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByTestId('canvas'));
  });

  it('closes the editor on Esc without changing the value', async () => {
    const { s } = await session();
    renderCanvas(s);
    fireEvent.doubleClick(screen.getByTestId('dimension-k3'));
    const input = screen.getByTestId('dimension-input');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('dimension-input')).toBeNull();
    expect(s.getState().sketch.constraints[2]).toMatchObject({ value: { source: '10' } });
  });

  it('takes left-button input from the viewport while it is shown', async () => {
    const { s } = await session();
    const { vp, view } = renderCanvas(s);
    const d = vp.delegate()!;
    expect(d).not.toBeNull();
    s.getState().setTool('circle');
    const at = (x: number, y: number) => ({ x: 200 + 10 * x, y: 200 - 10 * y });
    const click = (x: number, y: number) => {
      const e = { shiftKey: false, ctrlKey: false, metaKey: false, buttons: 1 } as PointerEvent;
      act(() => {
        expect(d.down(e, at(x, y))).toBe(true);
        d.up({ ...e, buttons: 0 } as PointerEvent, at(x, y));
      });
    };
    click(20, 20);
    click(23, 24);
    await act(() => s.getState().idle());
    const circle = s.getState().sketch.entities.at(-1)!;
    expect(circle).toMatchObject({ id: 'e3', kind: 'circle', center: [20, 20], radius: 5 });
    view.unmount();
    expect(vp.raw.setPointerDelegate).toHaveBeenLastCalledWith(null);
  });

  it('draws with press, drag and release too', async () => {
    const { s } = await session({}, [], []);
    const { vp } = renderCanvas(s);
    const d = vp.delegate()!;
    s.getState().setTool('line');
    const e = { shiftKey: true, ctrlKey: false, metaKey: false, buttons: 1 } as PointerEvent;
    act(() => {
      d.down(e, { x: 250, y: 250 });
      d.move(e, { x: 300, y: 250 });
      d.move(e, { x: 350, y: 240 });
      d.up({ ...e, buttons: 0 } as PointerEvent, { x: 350, y: 240 });
    });
    await act(() => s.getState().idle());
    expect(s.getState().sketch.entities).toEqual([
      { id: 'e3', kind: 'line', construction: false, start: [5, -5], end: [15, -4] },
    ]);
  });
});

describe('the sketch chrome', () => {
  it('shows the remaining degrees of freedom and the tool prompt', async () => {
    const { s } = await session({ dof: 2 });
    render(<SketchStatusBar session={s} />);
    const bar = screen.getByTestId('sketch-status');
    expect(bar.getAttribute('data-state')).toBe('under');
    expect(screen.getByTestId('sketch-dof').textContent).toBe('2 degrees of freedom left');
    act(() => s.getState().setTool('rectangle'));
    expect(bar.textContent).toContain('Click the first corner.');
  });

  it('explains a conflict, blames the newest constraint and deletes it on request', async () => {
    const { s, fake } = await session({ dof: null, conflicting: ['k2', 'k3'] });
    render(<ConflictPanel session={s} />);
    const rows = screen.getByTestId('conflict-panel').querySelectorAll('li');
    expect([...rows].map((r) => r.getAttribute('data-constraint'))).toEqual(['k3', 'k2']);
    expect(rows[0]!.textContent).toContain('Distance 10.00 mm');
    fake.setDiagnosis({ dof: 0, conflicting: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Distance 10.00 mm k3' }));
    await act(() => s.getState().idle());
    expect(s.getState().sketch.constraints.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(screen.queryByTestId('conflict-panel')).toBeNull();
  });

  it('enables a constraint button only when the selection fits it', async () => {
    const { s } = await session();
    const onFinish = vi.fn();
    render(<SketchToolbar session={s} onFinish={onFinish} onCancel={() => {}} />);
    const perpendicular = screen.getByRole('button', {
      name: /Perpendicular/,
    }) as HTMLButtonElement;
    expect(perpendicular.disabled).toBe(true);
    act(() => {
      s.getState().select({ kind: 'entity', id: 'e1' });
      s.getState().select({ kind: 'entity', id: 'e2' }, 'add');
    });
    expect(perpendicular.disabled).toBe(false);
    fireEvent.click(perpendicular);
    expect(s.getState().sketch.constraints.at(-1)).toEqual({
      id: 'k4',
      kind: 'perpendicular',
      a: 'e1',
      b: 'e2',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    expect(s.getState().tool).toBe('line');
    expect(screen.getByRole('button', { name: 'Line' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Finish sketch' }));
    expect(onFinish).toHaveBeenCalled();
  });
});

describe('sketch shortcuts', () => {
  function Shortcuts({ s }: { s: SketchSessionStore }) {
    useSketchShortcuts(s, true);
    return <input aria-label="field" />;
  }

  it('switches tools, applies constraints to the selection and deletes it', async () => {
    const { s } = await session();
    render(<Shortcuts s={s} />);
    fireEvent.keyDown(window, { key: 'l' });
    expect(s.getState().tool).toBe('line');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(s.getState().tool).toBe('select');
    act(() => s.getState().select({ kind: 'entity', id: 'e2' }));
    fireEvent.keyDown(window, { key: 'h' });
    expect(s.getState().sketch.constraints.at(-1)).toMatchObject({
      kind: 'horizontal',
      line: 'e2',
    });
    act(() => s.getState().select({ kind: 'constraint', id: 'k1' }));
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(s.getState().sketch.constraints.map((c) => c.id)).not.toContain('k1');
    // Typing in a field is not a shortcut.
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'r' });
    expect(s.getState().tool).toBe('select');
  });
});
