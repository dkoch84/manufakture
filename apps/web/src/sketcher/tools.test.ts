import type { ArcEntity, LineEntity, SketchEntity, Vec2 } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import { indexEntities } from './geometry';
import type { PickPoint } from './snap';
import {
  initialDrawState,
  isIdle,
  toolClick,
  toolEscape,
  toolMove,
  toolPreview,
  toolPrompt,
  type DrawState,
  type ToolContext,
} from './tools';

const ctx = (entities: SketchEntity[] = []): ToolContext => ({
  index: indexEntities(entities),
  construction: false,
  tolerance: 0.5,
});
const free = (p: Vec2): PickPoint => ({ position: p, target: null });
const onPoint = (p: Vec2, entity: string, at?: 'start' | 'end' | 'center'): PickPoint => ({
  position: p,
  target: { kind: 'point', ref: at ? { entity, at } : { entity } },
});

/** Feed clicks to a tool; return the drafts it emitted and its final state. */
function run(state: DrawState, picks: PickPoint[], c = ctx()) {
  const drafts = [];
  const messages: string[] = [];
  for (const p of picks) {
    const step = toolClick(state, p, c);
    state = step.state;
    if (step.draft) drafts.push(step.draft);
    if (step.message) messages.push(step.message);
  }
  return { state, drafts, messages };
}

describe('the line tool', () => {
  it('chains lines end to start and infers from the pick points', () => {
    const r = run(initialDrawState('line'), [
      onPoint([0, 0], '@origin'),
      { ...free([10, 0]), horizontal: true },
      { ...free([10, 5]), vertical: true },
    ]);
    expect(r.drafts).toHaveLength(2);
    const [first, second] = r.drafts;
    expect(first!.entities).toEqual([
      { id: '$0', kind: 'line', construction: false, start: [0, 0], end: [10, 0] },
    ]);
    expect(first!.constraints).toEqual([
      { kind: 'coincident', a: { entity: '@origin' }, b: { entity: '$0', at: 'start' } },
      { kind: 'horizontal', line: '$0' },
    ]);
    // The second line starts on the first one's end (still a temporary id here;
    // the session renames it when it adds the first line).
    expect(second!.constraints).toEqual([
      { kind: 'coincident', a: { entity: '$0', at: 'end' }, b: { entity: '$0', at: 'start' } },
      { kind: 'vertical', line: '$0' },
    ]);
    expect(r.state).toMatchObject({ tool: 'line', start: { position: [10, 5] } });
  });

  it('ends the chain when a line closes onto an existing point', () => {
    const r = run(initialDrawState('line'), [free([5, 5]), onPoint([0, 0], 'e1', 'start')]);
    expect(r.drafts[0]!.constraints).toEqual([
      { kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '$0', at: 'end' } },
    ]);
    expect(isIdle(r.state)).toBe(true);
  });

  it('ignores a second click on the start point', () => {
    const r = run(initialDrawState('line'), [free([1, 1]), free([1.1, 1])]);
    expect(r.drafts).toHaveLength(0);
    expect(r.state).toMatchObject({ start: { position: [1, 1] } });
  });

  it('puts point-on-curve for a curve snap, and tangency instead of a coincidence', () => {
    const r = run(initialDrawState('line'), [
      onPoint([0, 1], 'a1', 'end'),
      {
        position: [-5, 1],
        target: { kind: 'curve', entity: 'e7' },
        tangent: { entity: 'a1', at: 'end' },
      },
    ]);
    expect(r.drafts[0]!.constraints).toEqual([
      { kind: 'tangent', a: 'a1', b: '$0', at: ['end', 'start'] },
      { kind: 'pointOnObject', point: { entity: '$0', at: 'end' }, on: 'e7' },
    ]);
  });

  it('draws construction lines in construction mode', () => {
    const r = run(initialDrawState('line'), [free([0, 0]), free([3, 4])], {
      ...ctx(),
      construction: true,
    });
    expect(r.drafts[0]!.entities[0]!.construction).toBe(true);
  });
});

describe('the rectangle tools', () => {
  it('makes four joined, axis aligned lines counter-clockwise from the bottom left', () => {
    // Drawn from the top right to the bottom left.
    const r = run(initialDrawState('rectangle'), [free([10, 5]), onPoint([0, 0], '@origin')]);
    const d = r.drafts[0]!;
    const lines = d.entities as LineEntity[];
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 5],
      ],
      [
        [10, 5],
        [0, 5],
      ],
      [
        [0, 5],
        [0, 0],
      ],
    ]);
    const kinds = d.constraints.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'coincident')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'horizontal')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'vertical')).toHaveLength(2);
    // The origin snap lands on the bottom-left corner, the start of the bottom line.
    expect(d.constraints.at(-1)).toEqual({
      kind: 'coincident',
      a: { entity: '@origin' },
      b: { entity: '$0', at: 'start' },
    });
    expect(isIdle(r.state)).toBe(true);
  });

  it('refuses a rectangle without a width or a height', () => {
    const r = run(initialDrawState('rectangle'), [free([0, 0]), free([10, 0.1])]);
    expect(r.drafts).toHaveLength(0);
    expect(r.messages).toEqual(['A rectangle needs a width and a height.']);
    expect(r.state).toMatchObject({ first: { position: [0, 0] } });
  });

  it('makes a centre rectangle symmetric about a snapped centre', () => {
    const r = run(initialDrawState('centerRectangle'), [onPoint([0, 0], '@origin'), free([4, 3])]);
    const d = r.drafts[0]!;
    expect(d.entities).toHaveLength(4);
    expect((d.entities[0] as LineEntity).start).toEqual([-4, -3]);
    expect(d.constraints).toContainEqual({
      kind: 'symmetric',
      a: { entity: '$0', at: 'start' },
      b: { entity: '$2', at: 'start' },
      center: { entity: '@origin' },
    });
  });

  it('adds a centre point when the centre is not on a point', () => {
    const r = run(initialDrawState('centerRectangle'), [free([5, 5]), free([6, 7])]);
    const d = r.drafts[0]!;
    expect(d.entities[4]).toEqual({
      id: '$4',
      kind: 'point',
      construction: true,
      position: [5, 5],
    });
    expect(d.constraints.at(-1)).toMatchObject({ kind: 'symmetric', center: { entity: '$4' } });
  });
});

describe('the circle and arc tools', () => {
  it('draws a circle from its centre and a point on it', () => {
    const r = run(initialDrawState('circle'), [
      onPoint([0, 0], '@origin'),
      onPoint([3, 4], 'e1', 'end'),
    ]);
    const d = r.drafts[0]!;
    expect(d.entities[0]).toMatchObject({ kind: 'circle', center: [0, 0], radius: 5 });
    expect(d.constraints).toEqual([
      { kind: 'coincident', a: { entity: '@origin' }, b: { entity: '$0', at: 'center' } },
      { kind: 'pointOnObject', point: { entity: 'e1', at: 'end' }, on: '$0' },
    ]);
  });

  it('orders a three point arc counter-clockwise and ties the snaps to the drawn ends', () => {
    // From (1,0) to (-1,0) under the bottom: clockwise as drawn.
    const r = run(initialDrawState('arc3'), [
      onPoint([1, 0], 'e1', 'end'),
      free([-1, 0]),
      free([0, -1]),
    ]);
    const a = r.drafts[0]!.entities[0] as ArcEntity;
    expect(a.start).toEqual([-1, 0]);
    expect(a.end).toEqual([1, 0]);
    expect(r.drafts[0]!.constraints).toEqual([
      { kind: 'coincident', a: { entity: 'e1', at: 'end' }, b: { entity: '$0', at: 'end' } },
    ]);
    expect(
      run(initialDrawState('arc3'), [free([0, 0]), free([2, 0]), free([1, 0])]).messages,
    ).toEqual(['The three points are in a line.']);
  });

  it('starts a tangent arc only on the end of a line or arc', () => {
    const l: LineEntity = {
      id: 'e1',
      kind: 'line',
      construction: false,
      start: [0, 0],
      end: [10, 0],
    };
    const c = ctx([l]);
    const refused = toolClick(initialDrawState('tangentArc'), free([10, 0]), c);
    expect(refused.message).toBe('Start a tangent arc on the end of a line or arc.');
    const r = run(
      initialDrawState('tangentArc'),
      [onPoint([10, 0], 'e1', 'end'), free([12, 2])],
      c,
    );
    const a = r.drafts[0]!.entities[0] as ArcEntity;
    expect(a.center[0]).toBeCloseTo(10, 12);
    expect(a.center[1]).toBeCloseTo(2, 12);
    expect(r.drafts[0]!.constraints).toEqual([
      { kind: 'tangent', a: 'e1', b: '$0', at: ['end', 'start'] },
    ]);
    // Turning right stores the arc reversed: the joint is the arc's end.
    const right = run(
      initialDrawState('tangentArc'),
      [onPoint([10, 0], 'e1', 'end'), free([12, -2])],
      c,
    );
    expect(right.drafts[0]!.constraints[0]).toEqual({
      kind: 'tangent',
      a: 'e1',
      b: '$0',
      at: ['end', 'end'],
    });
  });

  it('sweeps a centre arc the way the pointer went round', () => {
    let s = run(initialDrawState('centerArc'), [free([0, 0]), free([5, 0])]).state;
    // Round clockwise through the bottom to the left.
    for (const p of [
      [4, -3],
      [0, -5],
      [-4, -3],
    ] as Vec2[]) {
      s = toolMove(s, free(p));
    }
    const step = toolClick(s, free([-5, 0]), ctx());
    const a = step.draft!.entities[0] as ArcEntity;
    // Clockwise from (5,0) to (-5,0) is stored counter-clockwise from (-5,0).
    expect(a.start[0]).toBeCloseTo(-5, 9);
    expect(a.end).toEqual([5, 0]);
  });
});

describe('tool state', () => {
  it('escapes the shape in progress first, then the tool', () => {
    const started = toolClick(initialDrawState('rectangle'), free([0, 0]), ctx()).state;
    expect(isIdle(started)).toBe(false);
    const once = toolEscape(started);
    expect(once).toEqual({ state: initialDrawState('rectangle'), exit: false });
    expect(toolEscape(once.state).exit).toBe(true);
  });

  it('previews the shape under the cursor without changing state', () => {
    const s = toolClick(initialDrawState('circle'), free([0, 0]), ctx()).state;
    const preview = toolPreview(s, free([2, 0]), ctx());
    expect(preview).toEqual([
      { id: '$0', kind: 'circle', construction: false, center: [0, 0], radius: 2 },
    ]);
    expect(toolPreview(initialDrawState('circle'), free([2, 0]), ctx())).toEqual([]);
    // A three point arc previews its chord until the third point.
    const arcStart = toolClick(initialDrawState('arc3'), free([0, 0]), ctx()).state;
    expect(toolPreview(arcStart, free([3, 0]), ctx())[0]).toMatchObject({
      kind: 'line',
      construction: true,
    });
  });

  it('prompts for the next click', () => {
    expect(toolPrompt(initialDrawState('line'))).toBe('Click the start of the line.');
    const s = toolClick(initialDrawState('arc3'), free([0, 0]), ctx()).state;
    expect(toolPrompt(s)).toBe('Click the end of the arc.');
  });
});
