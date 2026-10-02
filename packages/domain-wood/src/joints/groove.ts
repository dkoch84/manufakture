// Dados and rabbets: B's end or edge sits in a groove in A. One box cut from A where B enters it,
// as deep as B reaches into A and as wide as B's thickness plus the clearance. A dado's groove lies
// inside A's face; a rabbet's runs along an edge of A, so it is open on one side. A stopped dado
// stops short of one or both ends of its run, and B is notched where it would meet the wood left.

import { refuse, tooDeep, type Built, type Values } from './common';
import {
  AXIS_NAMES,
  LINEAR_TOL,
  boxTool,
  entryOf,
  thirdAxis,
  mm,
  type Pair,
  type V3,
} from './geometry';
import type { DadoParams, RabbetParams } from './params';

export function grooveJoint(p: Pair, params: DadoParams | RabbetParams, v: Values): Built {
  const { a, b } = p;
  const what = params.kind === 'dado' ? 'a dado' : 'a rabbet';
  const found = entryOf(p, what);
  if (!found.ok) refuse(found.message, ['params', 'b']);
  const e = found.entry.axis;
  const depth = found.entry.depth;
  // The groove's width runs along B's thickness; its length along the third axis.
  const k = p.map[2].axis;
  if (k === e) {
    refuse(
      `${b.id} lies with its face in ${a.id}: ${what} holds ${b.id}'s end or edge, so ${b.id}'s thickness must lie across the groove`,
      ['params', 'b'],
    );
  }
  const m = thirdAxis(e, k);
  const c = v.nonNegative('clearance', 0);
  const k0 = p.lo[k];
  const k1 = p.hi[k];
  const atLow = k0 <= LINEAR_TOL;
  const atHigh = k1 >= a.size[k] - LINEAR_TOL;
  if (atLow && atHigh) {
    refuse(
      `${b.id} covers the whole ${AXIS_NAMES[k]} of ${a.id}: there is no ${params.kind} to cut; draw ${b.id} thinner or join it another way`,
      ['params', 'b'],
    );
  }
  let groove: [number, number];
  if (params.kind === 'dado') {
    if (atLow || atHigh) {
      refuse(`${b.id} sits at an edge of ${a.id}: that is a rabbet, not a dado`, [
        'params',
        'kind',
      ]);
    }
    groove = [k0 - c / 2, k1 + c / 2];
  } else {
    if (!atLow && !atHigh) {
      refuse(`${b.id} does not sit at an edge of ${a.id}: that is a dado, not a rabbet`, [
        'params',
        'kind',
      ]);
    }
    groove = atLow ? [0, k1 + c] : [k0 - c, a.size[k]];
  }

  // Along its run: through A, or stopped short of either end.
  const stopped = params.kind === 'dado' ? params.stopped : 'none';
  let m0 = 0;
  let m1 = a.size[m];
  if (stopped === 'none') {
    if (v.has('stop'))
      refuse('a through dado has no stop: set where it stops first', ['expressions', 'stop']);
  } else {
    const stop = v.positive('stop');
    if (stop === undefined) {
      refuse('a stopped dado needs the distance it stops short of the edge', [
        'expressions',
        'stop',
      ]);
    }
    if (stopped === 'low' || stopped === 'both') m0 = stop;
    if (stopped === 'high' || stopped === 'both') m1 = a.size[m] - stop;
    if (!(m1 - m0 > LINEAR_TOL)) {
      refuse(`a ${mm(stop)} stop leaves no dado in ${a.id}'s ${mm(a.size[m])}`, [
        'expressions',
        'stop',
      ]);
    }
  }

  const range = (re: [number, number], rk: [number, number], rm: [number, number]) => {
    const lo: V3 = [0, 0, 0];
    const hi: V3 = [0, 0, 0];
    [lo[e], hi[e]] = re;
    [lo[k], hi[k]] = rk;
    [lo[m], hi[m]] = rm;
    return { lo, hi };
  };
  const inA: [number, number] = [p.lo[e], p.hi[e]];
  const g = range(inA, groove, [m0, m1]);
  const items = [boxTool(a, 'groove', a.id, g.lo, g.hi)];
  // B is notched where it runs past a stop, inside A only.
  const bk: [number, number] = [k0, k1];
  if (p.lo[m] < m0 - LINEAR_TOL) {
    const n = range(inA, bk, [p.lo[m], m0]);
    items.push(boxTool(a, 'notch-low', b.id, n.lo, n.hi));
  }
  if (p.hi[m] > m1 + LINEAR_TOL) {
    const n = range(inA, bk, [m1, p.hi[m]]);
    items.push(boxTool(a, 'notch-high', b.id, n.lo, n.hi));
  }
  const warnings =
    depth > a.size[e] / 2 + LINEAR_TOL
      ? [tooDeep(params.kind, depth, a.id, AXIS_NAMES[e], a.size[e])]
      : [];
  return {
    items,
    hardware: [],
    warnings,
    details: { depth, width: groove[1] - groove[0], length: m1 - m0 },
  };
}
