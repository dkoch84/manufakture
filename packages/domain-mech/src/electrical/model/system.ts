// The electrical system read into a model (ADR 0017 decision 11, task T9.7a): core stores
// `mech.electrical` (components, connections between their terminals, harness segments); this
// file resolves each component's terminals (its own, else its catalog connector's poles, else its
// role's defaults), its catalog entry and its instance, each connection's ends and wire, each
// segment's length (typed, or measured between instances plus slack), and lists what is wrong:
// a reference to something that is not there (a `mech-reference` warning), a terminal nothing
// connects to, a connection joining terminals that do not belong together, a value that does not
// read.
//
// A measured segment's length is the straight line between the origins of its ends' instances at
// their stored poses (the last solved pose of each instance), plus the slack the user typed for
// routing, bends and service loops. Nothing here follows a route around the parts.

import {
  MAX_TERMINALS,
  mechItems,
  type Assembly,
  type CatalogRef,
  type Component,
  type ComponentRole,
  type Connection,
  type Electrical,
  type Instance,
  type ManufaktureDocument,
  type Segment,
} from '@manufakture/core';
import type { DomainEvaluationWarning } from '@manufakture/regen';
import type { VariableLookup } from '@manufakture/units';
import { entryItem } from '../../parts/bom';
import { refText, resolveEntry } from '../../parts/catalog';
import { siValue } from '../../requirements/values';
import { ROLE_DEFS, roleTakesFamily, type TerminalDef, type TerminalKind } from './roles';

/** What is wrong with the electrical system, by its path from `mech.electrical`. */
export interface ElectricalProblem {
  path: readonly (string | number)[];
  message: string;
  /**
   * `reference`: it names an assembly, instance, component, terminal or purchased part that is
   * not there (regen's `mech-reference` warning); `dangling`: a terminal nothing connects to;
   * `structure`: the parts do not fit (a fuse using a motor entry, a power terminal wired to a
   * signal one); `value`: an expression that does not read or is out of range.
   */
  kind: 'reference' | 'dangling' | 'structure' | 'value';
  /** The id of what the problem is about: the missing id, or `<component>/<terminal>`. */
  target?: string;
  /** The component, connection or segment the problem is on. */
  item: string;
}

/** Where a component's terminals came from. */
export type TerminalSource = 'typed' | 'catalog' | 'role';

export interface ComponentResult {
  id: string;
  name: string;
  role: ComponentRole;
  terminals: TerminalDef[];
  terminalsFrom: TerminalSource;
  /** The purchased use, and its entry in words when it resolves: "Fuse Littelfuse 0314030". */
  use?: string;
  entry?: { ref: CatalogRef; item: string; family: string; verified: boolean };
  instance?: string;
  /** The typed always-on load: A and V; absent when not typed or not readable. */
  load?: { current?: number; voltage?: number };
}

/** One end of a connection, for people: "Pack (el#1) +". */
export interface EndResult {
  component: string;
  terminal: string;
  text: string;
  /** Absent when the component or the terminal is not there. */
  kind?: TerminalKind;
  /**
   * For a connector's pin: the kind its net carries, from the terminals of other components it
   * reaches through connector pins (`phase` if any is a phase, else `signal` if any is a signal,
   * else `power` or `ground`); absent when the pin reaches none.
   */
  effectiveKind?: TerminalKind;
}

export interface ConnectionResult {
  id: string;
  from: EndResult;
  to: EndResult;
  /** The wire's use and entry in words. */
  wire?: { use: string; item?: string };
  colour?: string;
  number?: string;
  /** The segments that carry it. */
  segments: string[];
}

export interface SegmentResult {
  id: string;
  /** For people: "Pack (el#1)", "Motor mount (inst#4)". */
  fromText: string;
  toText: string;
  /** m; absent when it cannot be found (then `missing` says why). */
  length?: number;
  /** For a measured segment: the straight-line distance and the slack, m. */
  measured?: { straight?: number; slack?: number };
  missing?: string;
  connections: string[];
}

/** The electrical system read into a model. Plain JSON. */
export interface ElectricalAnalysis {
  assembly?: string;
  components: ComponentResult[];
  connections: ConnectionResult[];
  harness: SegmentResult[];
  problems: ElectricalProblem[];
}

export interface ElectricalContext {
  document: ManufaktureDocument;
  variables: VariableLookup;
}

/** The assumption every measured length carries. */
export const MEASURED_LENGTH_ASSUMPTION =
  'straight line between the instances’ origins at their stored poses, plus the slack typed for routing';

const EMPTY: Electrical = { components: [], connections: [], harness: [] };

/** A component's terminals and where they came from. */
export function componentTerminals(
  doc: ManufaktureDocument,
  c: Component,
): { terminals: TerminalDef[]; from: TerminalSource } {
  if (c.terminals !== undefined)
    return { terminals: c.terminals.map((x) => ({ ...x })), from: 'typed' };
  if (c.role === 'connector' && c.use !== undefined) {
    const poles = connectorPoles(doc, c.use);
    if (poles !== undefined) {
      const n = Math.min(poles, MAX_TERMINALS);
      const terminals = Array.from({ length: n }, (_, i) => ({
        id: String(i + 1),
        name: `pin ${i + 1}`,
        kind: 'power' as const,
      }));
      return { terminals, from: 'catalog' };
    }
  }
  return { terminals: ROLE_DEFS[c.role].terminals.map((x) => ({ ...x })), from: 'role' };
}

/** A connector entry's pole count, when its use resolves and gives one. */
function connectorPoles(doc: ManufaktureDocument, useId: string): number | undefined {
  const use = mechItems(doc.mech, 'purchased').find((u) => u.id === useId);
  if (use === undefined) return undefined;
  const e = resolveEntry(doc, use.entry);
  if (!e.ok || e.entry.family !== 'connector') return undefined;
  const r = Object.hasOwn(e.entry.ratings, 'poles') ? e.entry.ratings.poles : undefined;
  if (r === undefined || !('value' in r)) return undefined;
  return Number.isInteger(r.value) && r.value >= 1 ? r.value : undefined;
}

function assemblyOf(doc: ManufaktureDocument, e: Electrical): Assembly | undefined {
  return e.assembly === undefined ? undefined : doc.assemblies?.find((a) => a.id === e.assembly);
}

/** The electrical system of a document read into a model; an empty one when it has none. */
export function analyseElectrical(ctx: ElectricalContext): ElectricalAnalysis {
  const doc = ctx.document;
  const e = doc.mech?.electrical ?? EMPTY;
  const problems: ElectricalProblem[] = [];
  const assembly = assemblyOf(doc, e);
  // A missing assembly is reported on each component and segment that names an instance in it;
  // only when none does is it reported once, on the system.
  const namesInstance =
    e.components.some((c) => c.instance !== undefined) ||
    e.harness.some((s) => 'instance' in s.from || 'instance' in s.to);
  if (e.assembly !== undefined && assembly === undefined && !namesInstance) {
    problems.push({
      path: ['assembly'],
      message: `there is no assembly ${e.assembly}`,
      kind: 'reference',
      target: e.assembly,
      item: e.assembly,
    });
  }
  const instanceRef = (item: string, path: (string | number)[], id: string) => {
    if (e.assembly === undefined) {
      problems.push({
        path,
        message: `names instance ${id}, but the electrical system names no assembly`,
        kind: 'reference',
        target: id,
        item,
      });
    } else if (assembly === undefined) {
      problems.push({
        path,
        message: `names instance ${id} of assembly ${e.assembly}, which is not there`,
        kind: 'reference',
        target: e.assembly,
        item,
      });
    } else if (!assembly.instances.some((i) => i.id === id)) {
      problems.push({
        path,
        message: `names instance ${id}, which ${assembly.name} does not have`,
        kind: 'reference',
        target: id,
        item,
      });
    }
  };
  const uses = mechItems(doc.mech, 'purchased');

  // Components.
  const seenComponents = new Set<string>();
  const components: ComponentResult[] = e.components.map((c, i) => {
    const p = (...rest: (string | number)[]) => ['components', i, ...rest];
    if (seenComponents.has(c.id)) {
      problems.push({
        path: p('id'),
        message: `${c.id} is used twice`,
        kind: 'structure',
        item: c.id,
      });
    }
    seenComponents.add(c.id);
    const { terminals, from } = componentTerminals(doc, c);
    const ids = new Set<string>();
    for (const [k, term] of terminals.entries()) {
      if (ids.has(term.id)) {
        problems.push({
          path: p('terminals', k, 'id'),
          message: `terminal ${term.id} is listed twice`,
          kind: 'structure',
          target: `${c.id}/${term.id}`,
          item: c.id,
        });
      }
      ids.add(term.id);
    }
    const out: ComponentResult = {
      id: c.id,
      name: c.name,
      role: c.role,
      terminals,
      terminalsFrom: from,
    };
    if (c.use !== undefined) {
      out.use = c.use;
      const use = uses.find((u) => u.id === c.use);
      if (use === undefined) {
        problems.push({
          path: p('use'),
          message: `names purchased part ${c.use}, which the design does not have`,
          kind: 'reference',
          target: c.use,
          item: c.id,
        });
      } else {
        const r = resolveEntry(doc, use.entry);
        if (!r.ok) {
          problems.push({
            path: p('use'),
            message: `${c.use} (${refText(use.entry)}): ${r.message}`,
            kind: 'reference',
            target: use.entry.id,
            item: c.id,
          });
        } else {
          out.entry = {
            ref: use.entry,
            item: entryItem(r.entry),
            family: r.entry.family,
            verified: r.entry.verified,
          };
          if (!roleTakesFamily(c.role, r.entry.family)) {
            problems.push({
              path: p('use'),
              message: `${c.use} is a ${r.entry.family}, which a ${ROLE_DEFS[c.role].text.toLowerCase()} does not use`,
              kind: 'structure',
              item: c.id,
            });
          }
        }
      }
    }
    if (c.instance !== undefined) {
      out.instance = c.instance;
      instanceRef(c.id, p('instance'), c.instance);
    }
    if (c.load !== undefined) {
      const load: { current?: number; voltage?: number } = {};
      const cur = siValue(c.load.current, 'current', ctx.variables);
      if (cur.ok && cur.value >= 0) load.current = cur.value;
      else {
        problems.push({
          path: p('load', 'current'),
          message: cur.ok ? 'a load current must not be below 0' : cur.message,
          kind: 'value',
          item: c.id,
        });
      }
      if (c.load.voltage !== undefined) {
        const v = siValue(c.load.voltage, 'voltage', ctx.variables);
        if (v.ok) load.voltage = v.value;
        else
          problems.push({
            path: p('load', 'voltage'),
            message: v.message,
            kind: 'value',
            item: c.id,
          });
      }
      out.load = load;
    }
    return out;
  });
  const byId = new Map(components.map((c) => [c.id, c]));
  const pinKinds = connectorPinKinds(components, e.connections);

  // Connections.
  const used = new Set<string>();
  const carried = new Map<string, string[]>();
  for (const s of e.harness) {
    for (const conn of s.connections) carried.set(conn, [...(carried.get(conn) ?? []), s.id]);
  }
  const end = (conn: Connection, i: number, side: 'from' | 'to'): EndResult => {
    const at = conn[side];
    const c = byId.get(at.component);
    const out: EndResult = {
      component: at.component,
      terminal: at.terminal,
      text: `${c === undefined ? at.component : `${c.name} (${c.id})`} ${at.terminal}`,
    };
    if (c === undefined) {
      problems.push({
        path: ['connections', i, side, 'component'],
        message: `names component ${at.component}, which the system does not have`,
        kind: 'reference',
        target: at.component,
        item: conn.id,
      });
      return out;
    }
    const term = c.terminals.find((x) => x.id === at.terminal);
    if (term === undefined) {
      problems.push({
        path: ['connections', i, side, 'terminal'],
        message: `names terminal ${at.terminal} of ${c.name} (${c.id}), which it does not have`,
        kind: 'reference',
        target: `${c.id}/${at.terminal}`,
        item: conn.id,
      });
      return out;
    }
    used.add(`${c.id}\n${term.id}`);
    const effective = pinKinds.get(`${c.id}\n${term.id}`);
    return {
      ...out,
      kind: term.kind,
      ...(effective !== undefined ? { effectiveKind: effective } : {}),
    };
  };
  const connections: ConnectionResult[] = e.connections.map((conn, i) => {
    const from = end(conn, i, 'from');
    const to = end(conn, i, 'to');
    if (from.component === to.component && from.terminal === to.terminal) {
      problems.push({
        path: ['connections', i],
        message: 'joins a terminal to itself',
        kind: 'structure',
        item: conn.id,
      });
    }
    // A connector's pin takes the kind of what its net reaches (`effectiveKind`).
    const fk = from.effectiveKind ?? from.kind;
    const tk = to.effectiveKind ?? to.kind;
    if (fk !== undefined && tk !== undefined && !kindsJoin(fk, tk)) {
      problems.push({
        path: ['connections', i],
        message: `joins a ${fk} terminal (${from.text}) to a ${tk} one (${to.text})`,
        kind: 'structure',
        item: conn.id,
      });
    }
    const out: ConnectionResult = { id: conn.id, from, to, segments: carried.get(conn.id) ?? [] };
    if (conn.wire !== undefined) {
      const use = uses.find((u) => u.id === conn.wire);
      if (use === undefined) {
        problems.push({
          path: ['connections', i, 'wire'],
          message: `names purchased part ${conn.wire}, which the design does not have`,
          kind: 'reference',
          target: conn.wire,
          item: conn.id,
        });
        out.wire = { use: conn.wire };
      } else {
        const r = resolveEntry(doc, use.entry);
        out.wire = { use: conn.wire, ...(r.ok ? { item: entryItem(r.entry) } : {}) };
        if (!r.ok) {
          problems.push({
            path: ['connections', i, 'wire'],
            message: `${conn.wire} (${refText(use.entry)}): ${r.message}`,
            kind: 'reference',
            target: use.entry.id,
            item: conn.id,
          });
        }
        if (r.ok && r.entry.family !== 'wire' && r.entry.family !== 'generic') {
          problems.push({
            path: ['connections', i, 'wire'],
            message: `${conn.wire} is a ${r.entry.family}, not a wire`,
            kind: 'structure',
            item: conn.id,
          });
        }
      }
    }
    if (conn.colour !== undefined) out.colour = conn.colour;
    if (conn.number !== undefined) out.number = conn.number;
    return out;
  });

  // Terminals nothing connects to.
  e.components.forEach((c, i) => {
    const r = components[i]!;
    r.terminals.forEach((term, k) => {
      if (used.has(`${c.id}\n${term.id}`)) return;
      problems.push({
        path: ['components', i, 'terminals', k],
        message: `terminal ${term.id} (${term.name}) of ${c.name} (${c.id}) is not connected`,
        kind: 'dangling',
        target: `${c.id}/${term.id}`,
        item: c.id,
      });
    });
  });

  // Harness segments.
  const instances = new Map((assembly?.instances ?? []).map((x) => [x.id, x]));
  const connIds = new Set(e.connections.map((c) => c.id));
  const harness: SegmentResult[] = e.harness.map((s, i) => {
    const p = (...rest: (string | number)[]) => ['harness', i, ...rest];
    const endOf = (side: 'from' | 'to') =>
      segmentEnd(s, side, byId, instances, p(side), problems, instanceRef);
    const a = endOf('from');
    const b = endOf('to');
    s.connections.forEach((conn, k) => {
      if (!connIds.has(conn)) {
        problems.push({
          path: p('connections', k),
          message: `names connection ${conn}, which the system does not have`,
          kind: 'reference',
          target: conn,
          item: s.id,
        });
      }
    });
    const out: SegmentResult = {
      id: s.id,
      fromText: a.text,
      toText: b.text,
      connections: [...s.connections],
    };
    if ('source' in s.length) {
      const len = siValue(s.length, 'length', ctx.variables);
      if (len.ok && len.value > 0) out.length = len.value;
      else {
        const message = len.ok ? 'a length must be above 0' : len.message;
        problems.push({ path: p('length'), message, kind: 'value', item: s.id });
        out.missing = `its length does not read: ${message}`;
      }
      return out;
    }
    const slack = siValue(s.length.slack, 'length', ctx.variables);
    const measured: { straight?: number; slack?: number } = {};
    const why: string[] = [];
    if (slack.ok && slack.value >= 0) measured.slack = slack.value;
    else {
      const message = slack.ok ? 'the slack must not be below 0' : slack.message;
      problems.push({ path: p('length', 'slack'), message, kind: 'value', item: s.id });
      why.push(`its slack does not read: ${message}`);
    }
    if (a.instance !== undefined && b.instance !== undefined) {
      const [x, y] = [a.instance.pose.translation, b.instance.pose.translation];
      measured.straight = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) / 1000;
    } else {
      why.push(...[a.missing, b.missing].filter((m): m is string => m !== undefined));
    }
    out.measured = measured;
    if (measured.straight !== undefined && measured.slack !== undefined) {
      out.length = measured.straight + measured.slack;
    } else out.missing = why.join('; ');
    return out;
  });

  return {
    ...(e.assembly !== undefined ? { assembly: e.assembly } : {}),
    components,
    connections,
    harness,
    problems,
  };
}

/**
 * The kind each connector pin carries, by `<component>\n<terminal>`: walk the connections from the
 * pin through other connector pins, and take the kinds of the other components' terminals
 * reached. A phase or signal line through any number of connectors keeps its kind.
 */
function connectorPinKinds(
  components: readonly ComponentResult[],
  connections: readonly Connection[],
): Map<string, TerminalKind> {
  const node = (c: string, t: string) => `${c}\n${t}`;
  const kind = new Map<string, TerminalKind>();
  const pin = new Set<string>();
  for (const c of components) {
    for (const t of c.terminals) {
      kind.set(node(c.id, t.id), t.kind);
      if (c.role === 'connector') pin.add(node(c.id, t.id));
    }
  }
  const adj = new Map<string, string[]>();
  for (const conn of connections) {
    const a = node(conn.from.component, conn.from.terminal);
    const b = node(conn.to.component, conn.to.terminal);
    if (!kind.has(a) || !kind.has(b)) continue;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const out = new Map<string, TerminalKind>();
  for (const start of pin) {
    if (out.has(start)) continue;
    // One pin net: every pin reached through pins, and the other terminals at its edge.
    const net = new Set([start]);
    const stack = [start];
    const reached = new Set<TerminalKind>();
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const m of adj.get(n) ?? []) {
        if (pin.has(m)) {
          if (!net.has(m)) {
            net.add(m);
            stack.push(m);
          }
        } else reached.add(kind.get(m)!);
      }
    }
    const k: TerminalKind | undefined = reached.has('phase')
      ? 'phase'
      : reached.has('signal')
        ? 'signal'
        : reached.has('power')
          ? 'power'
          : reached.has('ground')
            ? 'ground'
            : undefined;
    if (k !== undefined) for (const n of net) out.set(n, k);
  }
  return out;
}

/** Whether two terminal kinds may be wired together. */
function kindsJoin(a: TerminalKind, b: TerminalKind): boolean {
  if (a === b) return true;
  // Power and ground meet through fuses, switches and connector pins on either side of a load.
  return (a === 'power' || a === 'ground') && (b === 'power' || b === 'ground');
}

/** One end of a segment: its instance, or why it has none. */
function segmentEnd(
  s: Segment,
  side: 'from' | 'to',
  components: ReadonlyMap<string, ComponentResult>,
  instances: ReadonlyMap<string, Instance>,
  path: (string | number)[],
  problems: ElectricalProblem[],
  instanceRef: (item: string, path: (string | number)[], id: string) => void,
): { text: string; instance?: Instance; missing?: string } {
  const at = s[side];
  if ('component' in at) {
    const c = components.get(at.component);
    if (c === undefined) {
      problems.push({
        path: [...path, 'component'],
        message: `names component ${at.component}, which the system does not have`,
        kind: 'reference',
        target: at.component,
        item: s.id,
      });
      return { text: at.component, missing: `there is no component ${at.component}` };
    }
    const text = `${c.name} (${c.id})`;
    if (c.instance === undefined) {
      return { text, missing: `${text} is not placed in the assembly: give it an instance` };
    }
    const inst = instances.get(c.instance);
    return inst === undefined
      ? { text, missing: `${text} names instance ${c.instance}, which is not there` }
      : { text, instance: inst };
  }
  instanceRef(s.id, [...path, 'instance'], at.instance);
  const inst = instances.get(at.instance);
  return inst === undefined
    ? { text: at.instance, missing: `instance ${at.instance} is not there` }
    : { text: `${inst.name} (${inst.id})`, instance: inst };
}

/** A problem as one line: "connections.2.to.terminal: names terminal ...". */
export function electricalProblemText(p: ElectricalProblem): string {
  return p.path.length === 0 ? p.message : `${p.path.join('.')}: ${p.message}`;
}

/** A `mech-reference` warning per missing thing the electrical system names. */
export function electricalWarnings(analysis: ElectricalAnalysis): DomainEvaluationWarning[] {
  return analysis.problems
    .filter((p) => p.kind === 'reference' && p.target !== undefined)
    .map((p) => ({
      code: 'mech-reference' as const,
      message: `Electrical system, ${p.item}: ${electricalProblemText(p)}`,
      objectId: p.item,
      target: p.target!,
    }));
}
