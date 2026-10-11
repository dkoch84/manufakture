// The current each connection carries (ADR 0017 decision 11; task T9.7a lays the path, the
// simulation of T9.4b fills it, the electrical checks of T9.5f and the power budget of T9.7c read
// it). A connection's current comes from the components at its far side, by role: between a pack
// and a controller it is the controller's bus current, between a controller and a motor its phase
// current, between a brake output and a braking resistor the resistor's current, at a charger input
// the charge current, at a precharge the precharge current; the always-on parts (a controller
// board, a display, a DC-DC converter's input) add their typed `load`. Signal lines are taken as
// negligible.
//
// The simulated parts are series named `electrical/<component>/<quantity>` (`electricalSeries`),
// read through `SimulationEnvelopes` per load case with their `peak` and `rms`. Until T9.4b supplies
// envelopes every simulated part is unknown and says which load case has not run, so this hook is
// wired but empty: the structure (which connection carries which part) is final now.
//
// How the far side is found: the terminals are nodes; a connection joins two, and a fuse, a switch
// or a BMS joins its terminals inside (`ROLE_DEFS[role].parts`). Take the connection out: the side
// with a source (a pack, a converter's output, a brake output) feeds it, and every terminal that
// draws on the other side adds its current. A connection inside a loop (parallel paths) or fed from
// both sides is left unresolved, saying why: the model does not divide currents.

import { mechItems } from '@manufakture/core';
import { NO_SIMULATION, type SimulationEnvelopes } from '../../checks/simulation';
import {
  ROLE_DEFS,
  electricalSeries,
  type CurrentMode,
  type SimulatedQuantity,
  type TerminalPart,
} from './roles';
import { analyseElectrical, type ElectricalAnalysis, type ElectricalContext } from './system';

/** One part of a connection's current. */
export type CurrentContribution =
  | {
      kind: 'simulated';
      component: string;
      quantity: SimulatedQuantity;
      series: string;
      mode: CurrentMode;
    }
  /** A component's typed always-on load, A; `missing` when it has none that reads. */
  | { kind: 'load'; component: string; value?: number; missing?: string };

/** A connection's current in one load case, A. */
export interface CaseCurrent {
  loadCase: string;
  peak?: number;
  rms?: number;
  /** What is not known yet, naming what would give it. */
  missing: string[];
}

export type CurrentPath = 'power' | 'phase' | 'signal' | 'precharge';

export interface ConnectionCurrent {
  connection: string;
  path: CurrentPath;
  contributions: CurrentContribution[];
  /** The components feeding it (a pack, a converter, a controller's brake output). */
  sources: string[];
  /** Per load case of the document, in its order. */
  cases: CaseCurrent[];
  /** A: when every part is a typed load (or a signal line), the current in every load case. */
  steady?: number;
  /** Why the model cannot say what it carries. */
  unresolved?: string;
  assumptions: string[];
}

/** The assumption a signal line carries. */
export const SIGNAL_ASSUMPTION = 'a signal line: its current is taken as negligible';
const SUM_ASSUMPTION =
  'the sum of its parts’ peaks (and RMS values): an upper bound when they do not peak together';
const MODES_ASSUMPTION =
  'running and charging do not happen together: the larger of the two is taken';
const PRECHARGE_ASSUMPTION = 'carries current only while the bus charges at switch-on';

type Node = string;
const key = (component: string, terminal: string): Node => `${component}\n${terminal}`;

interface Graph {
  /** Edges by node: the other node and the connection id, or `null` inside a component. */
  adj: Map<Node, { to: Node; via: string | null }[]>;
  part: Map<Node, TerminalPart | undefined>;
  kind: Map<Node, string>;
  role: Map<string, string>;
}

function graph(analysis: ElectricalAnalysis): Graph {
  const adj = new Map<Node, { to: Node; via: string | null }[]>();
  const part = new Map<Node, TerminalPart | undefined>();
  const kind = new Map<Node, string>();
  const role = new Map<string, string>();
  const link = (a: Node, b: Node, via: string | null) => {
    adj.get(a)?.push({ to: b, via });
    adj.get(b)?.push({ to: a, via });
  };
  for (const c of analysis.components) {
    role.set(c.id, c.role);
    const parts = ROLE_DEFS[c.role].parts;
    const groups = new Map<number, Node[]>();
    for (const t of c.terminals) {
      const n = key(c.id, t.id);
      if (adj.has(n)) continue;
      adj.set(n, []);
      kind.set(n, t.kind);
      let p = Object.hasOwn(parts, t.id) ? parts[t.id] : undefined;
      // A terminal the role does not list draws the component's typed load, if it has one.
      if (p === undefined && c.load !== undefined && (t.kind === 'power' || t.kind === 'ground')) {
        p = { kind: 'draw', current: { from: 'load' } };
      }
      part.set(n, p);
      if (p?.kind === 'through') groups.set(p.group, [...(groups.get(p.group) ?? []), n]);
    }
    for (const g of groups.values()) for (let i = 1; i < g.length; i++) link(g[0]!, g[i]!, null);
  }
  for (const conn of analysis.connections) {
    const a = key(conn.from.component, conn.from.terminal);
    const b = key(conn.to.component, conn.to.terminal);
    if (adj.has(a) && adj.has(b) && a !== b) link(a, b, conn.id);
  }
  return { adj, part, kind, role };
}

/** The nodes reached from `start` without crossing connection `skip`. */
function reach(g: Graph, start: Node, skip: string): Set<Node> {
  const seen = new Set<Node>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const e of g.adj.get(n) ?? []) {
      if (e.via === skip || seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return seen;
}

const componentOf = (n: Node) => n.slice(0, n.indexOf('\n'));

/** The current of every connection of the document's electrical system, in its order. */
export function connectionCurrents(
  ctx: ElectricalContext,
  simulation: SimulationEnvelopes = NO_SIMULATION,
  analysis: ElectricalAnalysis = analyseElectrical(ctx),
): ConnectionCurrent[] {
  const g = graph(analysis);
  const loads = new Map(analysis.components.map((c) => [c.id, c]));
  const loadCases = mechItems(ctx.document.mech, 'loadCases');
  const out: ConnectionCurrent[] = [];
  for (const conn of analysis.connections) {
    const a = key(conn.from.component, conn.from.terminal);
    const b = key(conn.to.component, conn.to.terminal);
    const base = { connection: conn.id, contributions: [], sources: [], assumptions: [] };
    if (!g.adj.has(a) || !g.adj.has(b) || a === b) {
      out.push({
        ...base,
        path: 'power',
        cases: [],
        unresolved: 'one of its ends is not there',
      });
      continue;
    }
    // A connector pin carries what its net reaches (a phase or signal line through connectors).
    const kinds = [
      conn.from.effectiveKind ?? g.kind.get(a),
      conn.to.effectiveKind ?? g.kind.get(b),
    ];
    const precharge = [a, b].find((n) => g.part.get(n)?.kind === 'precharge');
    let path: CurrentPath;
    let contributions: CurrentContribution[] = [];
    let sources: string[] = [];
    let unresolved: string | undefined;
    const assumptions: string[] = [];
    const simulated = (component: string, quantity: SimulatedQuantity, mode: CurrentMode) =>
      ({
        kind: 'simulated',
        component,
        quantity,
        series: electricalSeries(component, quantity),
        mode,
      }) as const;
    if (precharge !== undefined) {
      path = 'precharge';
      contributions = [simulated(componentOf(precharge), 'precharge-current', 'precharge')];
      assumptions.push(PRECHARGE_ASSUMPTION);
    } else if (kinds.includes('signal')) {
      path = 'signal';
      assumptions.push(SIGNAL_ASSUMPTION);
    } else if (kinds.includes('phase')) {
      path = 'phase';
      // The controller (else the motor) on the phase line, through any connector pins.
      const reached = [...reach(g, a, '')].map(componentOf);
      const pick = (role: string) => reached.find((c) => g.role.get(c) === role);
      const owner = pick('controller') ?? pick('motor');
      if (owner === undefined) unresolved = 'no controller or motor on this phase line';
      else contributions = [simulated(owner, 'phase-current', 'use')];
    } else {
      path = 'power';
      const sideA = reach(g, a, conn.id);
      if (sideA.has(b)) {
        unresolved = 'it is on a loop of parallel paths, and the model does not divide currents';
      } else {
        const sideB = reach(g, b, conn.id);
        const feeds = (side: Set<Node>) =>
          [...side].filter((n) => g.part.get(n)?.kind === 'source').map(componentOf);
        const [fa, fb] = [feeds(sideA), feeds(sideB)];
        if (fa.length > 0 && fb.length > 0) {
          unresolved = `it is fed from both ends (${unique(fa).join(', ')} and ${unique(fb).join(', ')})`;
        } else if (fa.length === 0 && fb.length === 0) {
          unresolved = 'nothing feeds it: no pack, converter output or brake output on either side';
        } else {
          sources = unique(fa.length > 0 ? fa : fb);
          const far = fa.length > 0 ? sideB : sideA;
          const seen = new Set<string>();
          for (const n of far) {
            const p = g.part.get(n);
            if (p?.kind !== 'draw') continue;
            const c = componentOf(n);
            const k = p.current.from === 'load' ? `${c}\nload` : `${c}\n${p.current.quantity}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (p.current.from === 'simulation') {
              contributions.push(simulated(c, p.current.quantity, p.current.mode));
            } else {
              const current = loads.get(c)?.load?.current;
              const name = loads.get(c)?.name ?? c;
              contributions.push(
                current !== undefined
                  ? { kind: 'load', component: c, value: current }
                  : {
                      kind: 'load',
                      component: c,
                      missing: `no load current of ${name} (${c}): type it`,
                    },
              );
            }
          }
          contributions.sort((x, y) => x.component.localeCompare(y.component));
          if (contributions.length === 0) unresolved = 'nothing beyond it draws current';
          if (contributions.length > 1) assumptions.push(SUM_ASSUMPTION);
          const modes = new Set(
            contributions.flatMap((x) => (x.kind === 'simulated' ? [x.mode] : [])),
          );
          if (modes.size > 1) assumptions.push(MODES_ASSUMPTION);
        }
      }
    }
    const result: ConnectionCurrent = {
      connection: conn.id,
      path,
      contributions,
      sources,
      cases: [],
      assumptions,
    };
    if (unresolved !== undefined) {
      result.unresolved = unresolved;
      out.push(result);
      continue;
    }
    if (path === 'signal') {
      result.steady = 0;
      result.cases = loadCases.map((lc) => ({ loadCase: lc.id, peak: 0, rms: 0, missing: [] }));
      out.push(result);
      continue;
    }
    const steady = contributions.every((x) => x.kind === 'load')
      ? total(contributions, () => undefined)
      : undefined;
    if (steady?.peak !== undefined) result.steady = steady.peak;
    result.cases = loadCases.map((lc) => {
      const t = total(contributions, (series, statistic) => {
        const v = simulation.envelope(lc.id, series, statistic);
        if (v !== undefined) return { value: v };
        const state = simulation.state(lc.id);
        return {
          missing:
            state === 'budget'
              ? `${series}: the simulation of ${lc.id} stopped at its time budget`
              : state === 'done'
                ? `${series}: the simulation of ${lc.id} gives no such series`
                : `${series}: no simulation of ${lc.id} has run`,
        };
      });
      return {
        loadCase: lc.id,
        ...(t.peak !== undefined ? { peak: t.peak } : {}),
        ...(t.rms !== undefined ? { rms: t.rms } : {}),
        missing: t.missing,
      };
    });
    out.push(result);
  }
  return out;
}

/** The peak and RMS of a set of parts: per mode the sum, then the largest mode. */
function total(
  parts: readonly CurrentContribution[],
  read: (
    series: string,
    statistic: 'peak' | 'rms',
  ) => { value: number; missing?: undefined } | { value?: undefined; missing: string } | undefined,
): { peak?: number; rms?: number; missing: string[] } {
  const missing: string[] = [];
  let loads = 0;
  const byMode = new Map<CurrentMode, { peak: number; rms: number }>();
  for (const p of parts) {
    if (p.kind === 'load') {
      if (p.value === undefined) missing.push(p.missing!);
      else loads += p.value;
      continue;
    }
    const peak = read(p.series, 'peak');
    const rms = read(p.series, 'rms');
    if (peak?.value === undefined || rms?.value === undefined) {
      const why = peak?.missing ?? rms?.missing ?? `${p.series}: not given`;
      if (!missing.includes(why)) missing.push(why);
      continue;
    }
    const m = byMode.get(p.mode) ?? { peak: 0, rms: 0 };
    byMode.set(p.mode, { peak: m.peak + Math.abs(peak.value), rms: m.rms + Math.abs(rms.value) });
  }
  if (missing.length > 0) return { missing };
  const modes = [...byMode.values()];
  if (modes.length === 0) return { peak: loads, rms: loads, missing };
  return {
    peak: Math.max(...modes.map((m) => m.peak)) + loads,
    rms: Math.max(...modes.map((m) => m.rms)) + loads,
    missing,
  };
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
