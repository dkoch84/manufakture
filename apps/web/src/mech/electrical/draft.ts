// The electrical panel's draft (T9.7a): the whole electrical system as the user types it, every
// expression and terminal list as text, turned into core's `Electrical` on save (one
// `setElectrical`, so a save is one undo step). A field whose text is unchanged keeps its stored
// expression (and the units it was typed under). Fields the panel has no control for (a
// component's diagram nudges, `layout`) are kept as stored.
//
// A component's terminals are typed as `id kind` pairs separated by commas (`vin power, gnd
// ground, sda signal`); empty text means the role's (or the connector entry's) defaults. A typed
// terminal keeps the name it had, else the role's name for that id, else its id.

import {
  MECH_COUNTERS,
  TERMINAL_ID_PATTERN,
  type Component,
  type ComponentRole,
  type Connection,
  type DisplayUnits,
  type Electrical,
  type Segment,
  type StoredExpression,
} from '@manufakture/core';
import { ROLE_DEFS, type TerminalKind } from '@manufakture/domain-mech';
import { nextMechId } from '../drivetrain/draft';
import { keptExpression } from '../requirements/draft';

export interface ComponentDraft {
  id: string;
  name: string;
  role: ComponentRole;
  /** A purchased use, or ''. */
  use: string;
  /** An instance of the system's assembly, or ''. */
  instance: string;
  /** `id kind` pairs, or '' for the defaults. */
  terminals: string;
  /** The always-on load, or ''. */
  current: string;
  voltage: string;
  original?: Component;
}

export interface ConnectionDraft {
  id: string;
  fromComponent: string;
  fromTerminal: string;
  toComponent: string;
  toTerminal: string;
  /** A purchased use of a wire, or ''. */
  wire: string;
  colour: string;
  number: string;
  original?: Connection;
}

/** A segment end as one value: `component:el#1` or `instance:inst#2`, or ''. */
export type EndValue = string;

export interface SegmentDraft {
  id: string;
  from: EndValue;
  to: EndValue;
  measured: boolean;
  /** Typed length. */
  length: string;
  /** Slack added to a measured length. */
  slack: string;
  /** Connection ids separated by commas. */
  connections: string;
  original?: Segment;
}

export interface ElectricalDraft {
  assembly: string;
  components: ComponentDraft[];
  connections: ConnectionDraft[];
  harness: SegmentDraft[];
}

const TERMINAL_KINDS: readonly TerminalKind[] = ['power', 'ground', 'phase', 'signal'];

export function terminalsText(terminals: Component['terminals']): string {
  return terminals === undefined ? '' : terminals.map((t) => `${t.id} ${t.kind}`).join(', ');
}

export function componentDraft(c: Component): ComponentDraft {
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    use: c.use ?? '',
    instance: c.instance ?? '',
    terminals: terminalsText(c.terminals),
    current: c.load?.current.source ?? '',
    voltage: c.load?.voltage?.source ?? '',
    original: c,
  };
}

export function connectionDraft(c: Connection): ConnectionDraft {
  return {
    id: c.id,
    fromComponent: c.from.component,
    fromTerminal: c.from.terminal,
    toComponent: c.to.component,
    toTerminal: c.to.terminal,
    wire: c.wire ?? '',
    colour: c.colour ?? '',
    number: c.number ?? '',
    original: c,
  };
}

const endValue = (e: Segment['from']): EndValue =>
  'component' in e ? `component:${e.component}` : `instance:${e.instance}`;

export function segmentDraft(s: Segment): SegmentDraft {
  const measured = !('source' in s.length);
  return {
    id: s.id,
    from: endValue(s.from),
    to: endValue(s.to),
    measured,
    length: 'source' in s.length ? s.length.source : '',
    slack: 'source' in s.length ? '' : s.length.slack.source,
    connections: s.connections.join(', '),
    original: s,
  };
}

export function electricalDraft(e: Electrical | undefined): ElectricalDraft {
  return {
    assembly: e?.assembly ?? '',
    components: (e?.components ?? []).map(componentDraft),
    connections: (e?.connections ?? []).map(connectionDraft),
    harness: (e?.harness ?? []).map(segmentDraft),
  };
}

/** A draft with a new component of `role` at the end. */
export function withComponent(
  d: ElectricalDraft,
  role: ComponentRole,
  nextIds: Readonly<Record<string, number>>,
): ElectricalDraft {
  const id = nextMechId(
    nextIds,
    MECH_COUNTERS.component,
    d.components.map((c) => c.id),
  );
  const component: ComponentDraft = {
    id,
    name: ROLE_DEFS[role].text,
    role,
    use: '',
    instance: '',
    terminals: '',
    current: '',
    voltage: '',
  };
  return { ...d, components: [...d.components, component] };
}

/** A draft with a new, unfilled connection at the end. */
export function withConnection(
  d: ElectricalDraft,
  nextIds: Readonly<Record<string, number>>,
): ElectricalDraft {
  const id = nextMechId(
    nextIds,
    MECH_COUNTERS.connection,
    d.connections.map((c) => c.id),
  );
  const connection: ConnectionDraft = {
    id,
    fromComponent: '',
    fromTerminal: '',
    toComponent: '',
    toTerminal: '',
    wire: '',
    colour: '',
    number: '',
  };
  return { ...d, connections: [...d.connections, connection] };
}

/** A draft with a new segment at the end, measured with no slack typed yet. */
export function withSegment(
  d: ElectricalDraft,
  nextIds: Readonly<Record<string, number>>,
): ElectricalDraft {
  const id = nextMechId(
    nextIds,
    MECH_COUNTERS.segment,
    d.harness.map((s) => s.id),
  );
  const segment: SegmentDraft = {
    id,
    from: '',
    to: '',
    measured: true,
    length: '',
    slack: '',
    connections: '',
  };
  return { ...d, harness: [...d.harness, segment] };
}

/** A draft with component `id` removed, along with the connections at its terminals. */
export function withoutComponent(d: ElectricalDraft, id: string): ElectricalDraft {
  const gone = new Set(
    d.connections.filter((c) => c.fromComponent === id || c.toComponent === id).map((c) => c.id),
  );
  return {
    ...d,
    components: d.components.filter((c) => c.id !== id),
    connections: d.connections.filter((c) => !gone.has(c.id)),
    harness: d.harness.map((s) => ({
      ...s,
      connections: splitIds(s.connections)
        .filter((c) => !gone.has(c))
        .join(', '),
    })),
  };
}

/** A draft with connection `id` removed, and from the segments that carried it. */
export function withoutConnection(d: ElectricalDraft, id: string): ElectricalDraft {
  return {
    ...d,
    connections: d.connections.filter((c) => c.id !== id),
    harness: d.harness.map((s) => ({
      ...s,
      connections: splitIds(s.connections)
        .filter((c) => c !== id)
        .join(', '),
    })),
  };
}

const splitIds = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

type Built<T> = { ok: true; value: T } | { ok: false; message: string };

/** A component's typed terminals, or what is wrong with the text. */
export function parseTerminals(
  text: string,
  role: ComponentRole,
  original: Component['terminals'],
): Built<Component['terminals']> {
  if (text.trim() === '') return { ok: true, value: undefined };
  const out: NonNullable<Component['terminals']> = [];
  for (const entry of text.split(',')) {
    const parts = entry.trim().split(/\s+/);
    if (parts.length === 1 && parts[0] === '') continue;
    const [id, kind, ...rest] = parts;
    if (rest.length > 0 || kind === undefined) {
      return { ok: false, message: `"${entry.trim()}": write a terminal as its id and kind` };
    }
    if (!TERMINAL_ID_PATTERN.test(id!)) {
      return {
        ok: false,
        message: `"${id}" is not a terminal id: letters, digits and + - _ . only, at most 32`,
      };
    }
    if (!TERMINAL_KINDS.includes(kind as TerminalKind)) {
      return {
        ok: false,
        message: `"${kind}" is not a terminal kind: ${TERMINAL_KINDS.join(', ')}`,
      };
    }
    const name =
      original?.find((t) => t.id === id)?.name ??
      ROLE_DEFS[role].terminals.find((t) => t.id === id)?.name ??
      id!;
    out.push({ id: id!, name, kind: kind as TerminalKind });
  }
  return { ok: true, value: out.length === 0 ? undefined : out };
}

function parseEnd(v: EndValue): Segment['from'] | undefined {
  if (v.startsWith('component:')) return { component: v.slice('component:'.length) };
  if (v.startsWith('instance:')) return { instance: v.slice('instance:'.length) };
  return undefined;
}

/** The electrical system a draft gives, or the first thing missing from it. */
export function electricalFromDraft(d: ElectricalDraft, units: DisplayUnits): Built<Electrical> {
  const expr = (old: StoredExpression | undefined, text: string) =>
    keptExpression(old, text, units);
  const components: Component[] = [];
  for (const [i, c] of d.components.entries()) {
    const where = `component ${i + 1} (${c.id})`;
    if (c.name.trim() === '') return { ok: false, message: `${where}: give it a name` };
    const terminals = parseTerminals(c.terminals, c.role, c.original?.terminals);
    if (!terminals.ok) return { ok: false, message: `${where}: ${terminals.message}` };
    if (c.current.trim() === '' && c.voltage.trim() !== '') {
      return { ok: false, message: `${where}: type the load's current with its voltage` };
    }
    const old = c.original?.load;
    const load =
      c.current.trim() === ''
        ? undefined
        : {
            current: expr(old?.current, c.current),
            ...(c.voltage.trim() !== '' ? { voltage: expr(old?.voltage, c.voltage) } : {}),
          };
    components.push({
      id: c.id,
      name: c.name.trim(),
      role: c.role,
      ...(c.use !== '' ? { use: c.use } : {}),
      ...(c.instance !== '' ? { instance: c.instance } : {}),
      ...(terminals.value !== undefined ? { terminals: terminals.value } : {}),
      ...(load !== undefined ? { load } : {}),
      ...(c.original?.layout !== undefined ? { layout: c.original.layout } : {}),
    });
  }
  const connections: Connection[] = [];
  for (const [i, c] of d.connections.entries()) {
    const where = `connection ${i + 1} (${c.id})`;
    if (c.fromComponent === '' || c.fromTerminal === '') {
      return { ok: false, message: `${where}: choose where it starts` };
    }
    if (c.toComponent === '' || c.toTerminal === '') {
      return { ok: false, message: `${where}: choose where it ends` };
    }
    connections.push({
      id: c.id,
      from: { component: c.fromComponent, terminal: c.fromTerminal },
      to: { component: c.toComponent, terminal: c.toTerminal },
      ...(c.wire !== '' ? { wire: c.wire } : {}),
      ...(c.colour.trim() !== '' ? { colour: c.colour.trim() } : {}),
      ...(c.number.trim() !== '' ? { number: c.number.trim() } : {}),
    });
  }
  const harness: Segment[] = [];
  for (const [i, s] of d.harness.entries()) {
    const where = `segment ${i + 1} (${s.id})`;
    const from = parseEnd(s.from);
    const to = parseEnd(s.to);
    if (from === undefined || to === undefined) {
      return { ok: false, message: `${where}: choose both of its ends` };
    }
    const old = s.original?.length;
    let length: Segment['length'];
    if (s.measured) {
      if (s.slack.trim() === '') {
        return { ok: false, message: `${where}: type the slack (0 for none)` };
      }
      const was = old !== undefined && !('source' in old) ? old.slack : undefined;
      length = { measured: true, slack: expr(was, s.slack) };
    } else {
      if (s.length.trim() === '') return { ok: false, message: `${where}: type its length` };
      length = expr(old !== undefined && 'source' in old ? old : undefined, s.length);
    }
    harness.push({ id: s.id, from, to, length, connections: splitIds(s.connections) });
  }
  return {
    ok: true,
    value: {
      ...(d.assembly !== '' ? { assembly: d.assembly } : {}),
      components,
      connections,
      harness,
    },
  };
}
