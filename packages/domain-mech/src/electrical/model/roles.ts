// What each role of an electrical component is (ADR 0017 decision 11, task T9.7a): its default
// terminals, which of them conduct through the component, which feed a circuit and which draw
// from it, and which catalog families a component of that role may use.
//
// Terminal ids are stable: schematic ports (decision 12, T9.7d) and connections name them, so a
// default terminal id published here is never renamed or removed, exactly as a built-in catalog
// entry is never edited. A new default terminal may be added; a document that already connects
// the component is unaffected, and the new terminal shows as not connected.

import type { CatalogFamily, ComponentRole } from '@manufakture/core';

export type TerminalKind = 'power' | 'ground' | 'phase' | 'signal';

export interface TerminalDef {
  id: string;
  name: string;
  kind: TerminalKind;
}

/**
 * How a terminal takes part in the current paths (`./currents`): `source` feeds a circuit (a
 * pack, a DC-DC converter's output, a controller's brake output), `draw` takes current from one
 * (with what the current is: a simulated series or the component's typed load), `through`
 * conducts to the other terminals of its group, `precharge` conducts only while the bus charges.
 */
export type TerminalPart =
  | { kind: 'source' }
  | { kind: 'draw'; current: DrawCurrent }
  | { kind: 'through'; group: number }
  | { kind: 'precharge' };

/** What a drawing terminal's current is. */
export type DrawCurrent =
  /** A series of the simulation for this component (`electricalSeries(component, quantity)`). */
  | { from: 'simulation'; quantity: SimulatedQuantity; mode: CurrentMode }
  /** The component's typed `load.current`. */
  | { from: 'load' };

/**
 * The currents the simulation (T9.4b) is to give per component, as series named
 * `electrical/<component id>/<quantity>` (`electricalSeries`), each with its `peak` and `rms`.
 */
export type SimulatedQuantity =
  'bus-current' | 'phase-current' | 'resistor-current' | 'charge-current' | 'precharge-current';

/**
 * When a current flows: `use` while the machine runs, `charge` while it charges, `precharge` while
 * the bus charges at switch-on. Typed loads flow in every mode.
 */
export type CurrentMode = 'use' | 'charge' | 'precharge';

export interface RoleDef {
  /** For people: "Battery pack". */
  text: string;
  terminals: readonly TerminalDef[];
  /** By terminal id; a terminal the role does not list (a user's own) is `load` if the component
   * has one, else it takes no part. */
  parts: Readonly<Record<string, TerminalPart>>;
  /** The catalog families a component of this role may use; `generic` always may. */
  families: readonly CatalogFamily[];
}

const t = (id: string, kind: TerminalKind, name = id): TerminalDef => ({ id, name, kind });
const SOURCE: TerminalPart = { kind: 'source' };
const LOAD: TerminalPart = { kind: 'draw', current: { from: 'load' } };
const through = (group: number): TerminalPart => ({ kind: 'through', group });
const sim = (quantity: SimulatedQuantity, mode: CurrentMode = 'use'): TerminalPart => ({
  kind: 'draw',
  current: { from: 'simulation', quantity, mode },
});

/** Every role, in core's order. */
export const ROLE_DEFS: Readonly<Record<ComponentRole, RoleDef>> = {
  pack: {
    text: 'Battery pack',
    terminals: [t('+', 'power'), t('-', 'ground')],
    parts: { '+': SOURCE, '-': SOURCE },
    families: ['pack', 'cell'],
  },
  bms: {
    text: 'Battery management (BMS)',
    terminals: [
      t('b+', 'power', 'B+ (pack side)'),
      t('b-', 'ground', 'B- (pack side)'),
      t('p+', 'power', 'P+ (load side)'),
      t('p-', 'ground', 'P- (load side)'),
      t('signal', 'signal'),
    ],
    parts: { 'b+': through(0), 'p+': through(0), 'b-': through(1), 'p-': through(1) },
    families: ['bms'],
  },
  fuse: {
    text: 'Fuse',
    terminals: [t('1', 'power'), t('2', 'power')],
    parts: { '1': through(0), '2': through(0) },
    families: ['fuse'],
  },
  switch: {
    text: 'Switch or contactor',
    terminals: [t('1', 'power'), t('2', 'power')],
    parts: { '1': through(0), '2': through(0) },
    families: ['switch'],
  },
  precharge: {
    text: 'Precharge',
    terminals: [t('1', 'power'), t('2', 'power')],
    parts: { '1': { kind: 'precharge' }, '2': { kind: 'precharge' } },
    families: ['resistor', 'switch'],
  },
  controller: {
    text: 'Motor controller',
    terminals: [
      t('bus+', 'power'),
      t('bus-', 'ground'),
      t('a', 'phase', 'phase A'),
      t('b', 'phase', 'phase B'),
      t('c', 'phase', 'phase C'),
      t('brake+', 'power'),
      t('brake-', 'power'),
      t('signal', 'signal'),
    ],
    parts: {
      'bus+': sim('bus-current'),
      'bus-': sim('bus-current'),
      'brake+': SOURCE,
      'brake-': SOURCE,
    },
    families: ['controller'],
  },
  'brake-resistor': {
    text: 'Braking resistor',
    terminals: [t('1', 'power'), t('2', 'power')],
    parts: { '1': sim('resistor-current'), '2': sim('resistor-current') },
    families: ['resistor'],
  },
  chopper: {
    text: 'Brake chopper',
    terminals: [
      t('bus+', 'power'),
      t('bus-', 'ground'),
      t('r+', 'power', 'resistor +'),
      t('r-', 'power', 'resistor -'),
      t('signal', 'signal'),
    ],
    parts: { 'bus+': sim('bus-current'), 'bus-': sim('bus-current'), 'r+': SOURCE, 'r-': SOURCE },
    families: ['controller', 'switch'],
  },
  motor: {
    text: 'Motor',
    terminals: [t('a', 'phase', 'phase A'), t('b', 'phase', 'phase B'), t('c', 'phase', 'phase C')],
    parts: {},
    families: ['motor'],
  },
  'charger-input': {
    text: 'Charger input',
    terminals: [t('+', 'power'), t('-', 'ground')],
    parts: { '+': sim('charge-current', 'charge'), '-': sim('charge-current', 'charge') },
    families: ['connector'],
  },
  dcdc: {
    text: 'DC-DC converter',
    terminals: [t('in+', 'power'), t('in-', 'ground'), t('out+', 'power'), t('out-', 'ground')],
    parts: { 'in+': LOAD, 'in-': LOAD, 'out+': SOURCE, 'out-': SOURCE },
    families: [],
  },
  board: {
    text: 'Controller board',
    terminals: [t('vin', 'power', 'VIN'), t('gnd', 'ground', 'GND'), t('signal', 'signal')],
    parts: { vin: LOAD, gnd: LOAD },
    families: [],
  },
  encoder: {
    text: 'Encoder',
    terminals: [t('vcc', 'power', 'VCC'), t('gnd', 'ground', 'GND'), t('signal', 'signal')],
    parts: { vcc: LOAD, gnd: LOAD },
    families: [],
  },
  'load-cell': {
    text: 'Load cell',
    terminals: [
      t('exc+', 'power', 'excitation +'),
      t('exc-', 'ground', 'excitation -'),
      t('sig+', 'signal', 'signal +'),
      t('sig-', 'signal', 'signal -'),
    ],
    parts: { 'exc+': LOAD, 'exc-': LOAD },
    families: [],
  },
  display: {
    text: 'Display',
    terminals: [t('vcc', 'power', 'VCC'), t('gnd', 'ground', 'GND'), t('signal', 'signal')],
    parts: { vcc: LOAD, gnd: LOAD },
    families: [],
  },
  connector: {
    text: 'Connector',
    terminals: [t('1', 'power', 'pin 1'), t('2', 'power', 'pin 2')],
    parts: {},
    families: ['connector'],
  },
  other: {
    text: 'Other',
    terminals: [],
    parts: {},
    families: [],
  },
};

/** The role in words: "Battery pack". */
export function roleText(role: ComponentRole): string {
  return ROLE_DEFS[role].text;
}

/** The kinds of terminal, for people. */
export const TERMINAL_KIND_TEXT: Readonly<Record<TerminalKind, string>> = {
  power: 'power',
  ground: 'ground',
  phase: 'motor phase',
  signal: 'signal',
};

/** Whether a component of `role` may use an entry of `family`. */
export function roleTakesFamily(role: ComponentRole, family: CatalogFamily): boolean {
  return role === 'other' || family === 'generic' || ROLE_DEFS[role].families.includes(family);
}

/** The series of the simulation that carries one component's current. */
export function electricalSeries(component: string, quantity: SimulatedQuantity): string {
  return `electrical/${component}/${quantity}`;
}
