// The cable trainer's electrical system as a template (T9.7a acceptance: "the cable trainer's
// system entered, with every connection carrying a simulated current"). Adding it appends its
// components and connections to the document's electrical system, with fresh ids, in one undo
// step. The parts are generic (no purchased part chosen) and placed nowhere: choose the parts and
// the instances afterwards. The always-on loads are estimates to replace with the datasheets'
// values; the template names them as such. It has no harness: segments need the parts placed.
//
// The topology follows T9.0c's research and the plan's "cable trainer, by the numbers": a pack
// through its BMS and a main fuse to a contactor with a precharge across it, the motor controller
// on the bus with its brake output driving a braking resistor (the controller's own chopper), the
// motor on its three phases, a charger input on the BMS's load side, and a DC-DC converter feeding
// the controller board, the encoder, the load cell and the display.

import {
  MAX_COMPONENTS,
  MAX_CONNECTIONS,
  MECH_COUNTERS,
  bareUnits,
  peekCounter,
  type Command,
  type Component,
  type ComponentRole,
  type Connection,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';

/** Components of the template by key, with what each one is. */
interface TemplateComponent {
  key: string;
  name: string;
  role: ComponentRole;
  terminals?: Component['terminals'];
  /** Estimates: replace with the datasheet's value. */
  load?: { current: string; voltage?: string };
}

const COMPONENTS: readonly TemplateComponent[] = [
  { key: 'pack', name: 'Pack', role: 'pack' },
  { key: 'bms', name: 'BMS', role: 'bms' },
  { key: 'fuse', name: 'Main fuse', role: 'fuse' },
  { key: 'contactor', name: 'Contactor', role: 'switch' },
  { key: 'precharge', name: 'Precharge', role: 'precharge' },
  { key: 'controller', name: 'Motor controller', role: 'controller' },
  { key: 'resistor', name: 'Braking resistor', role: 'brake-resistor' },
  { key: 'motor', name: 'Motor', role: 'motor' },
  { key: 'charger', name: 'Charger input', role: 'charger-input' },
  { key: 'dcdc', name: 'DC-DC converter', role: 'dcdc', load: { current: '25 mA' } },
  {
    key: 'board',
    name: 'Controller board',
    role: 'board',
    terminals: [
      { id: 'vin', name: 'VIN', kind: 'power' },
      { id: 'gnd', name: 'GND', kind: 'ground' },
      { id: 'ctrl', name: 'motor controller link', kind: 'signal' },
      { id: 'bms', name: 'BMS link', kind: 'signal' },
      { id: 'enc', name: 'encoder', kind: 'signal' },
      { id: 'lc+', name: 'load cell +', kind: 'signal' },
      { id: 'lc-', name: 'load cell -', kind: 'signal' },
      { id: 'disp', name: 'display', kind: 'signal' },
    ],
    load: { current: '80 mA', voltage: '5 V' },
  },
  { key: 'encoder', name: 'Encoder', role: 'encoder', load: { current: '20 mA', voltage: '5 V' } },
  {
    key: 'loadcell',
    name: 'Load cell',
    role: 'load-cell',
    load: { current: '15 mA', voltage: '5 V' },
  },
  { key: 'display', name: 'Display', role: 'display', load: { current: '60 mA', voltage: '5 V' } },
];

/** Connections of the template: `[from key, terminal, to key, terminal, colour]`. */
const CONNECTIONS: readonly [string, string, string, string, string][] = [
  ['pack', '+', 'bms', 'b+', 'red'],
  ['pack', '-', 'bms', 'b-', 'black'],
  ['bms', 'p+', 'fuse', '1', 'red'],
  ['fuse', '2', 'contactor', '1', 'red'],
  ['contactor', '2', 'controller', 'bus+', 'red'],
  ['bms', 'p-', 'controller', 'bus-', 'black'],
  ['contactor', '1', 'precharge', '1', 'red'],
  ['precharge', '2', 'contactor', '2', 'red'],
  ['controller', 'a', 'motor', 'a', 'yellow'],
  ['controller', 'b', 'motor', 'b', 'green'],
  ['controller', 'c', 'motor', 'c', 'blue'],
  ['controller', 'brake+', 'resistor', '1', 'white'],
  ['controller', 'brake-', 'resistor', '2', 'white'],
  ['charger', '+', 'bms', 'p+', 'red'],
  ['charger', '-', 'bms', 'p-', 'black'],
  ['bms', 'p+', 'dcdc', 'in+', 'red'],
  ['bms', 'p-', 'dcdc', 'in-', 'black'],
  ['dcdc', 'out+', 'board', 'vin', 'red'],
  ['dcdc', 'out-', 'board', 'gnd', 'black'],
  ['dcdc', 'out+', 'encoder', 'vcc', 'red'],
  ['dcdc', 'out-', 'encoder', 'gnd', 'black'],
  ['dcdc', 'out+', 'loadcell', 'exc+', 'red'],
  ['dcdc', 'out-', 'loadcell', 'exc-', 'black'],
  ['dcdc', 'out+', 'display', 'vcc', 'red'],
  ['dcdc', 'out-', 'display', 'gnd', 'black'],
  ['controller', 'signal', 'board', 'ctrl', 'grey'],
  ['bms', 'signal', 'board', 'bms', 'grey'],
  ['encoder', 'signal', 'board', 'enc', 'grey'],
  ['loadcell', 'sig+', 'board', 'lc+', 'grey'],
  ['loadcell', 'sig-', 'board', 'lc-', 'grey'],
  ['display', 'signal', 'board', 'disp', 'grey'],
];

export type ElectricalTemplateResult =
  | { ok: true; command: Command; label: string; componentIds: string[]; connectionIds: string[] }
  | { ok: false; message: string };

/** One `setElectrical` that appends the cable trainer's electrical system to the document's. */
export function electricalTemplateCommand(doc: ManufaktureDocument): ElectricalTemplateResult {
  const have = doc.mech?.electrical ?? { components: [], connections: [], harness: [] };
  if (have.components.length + COMPONENTS.length > MAX_COMPONENTS) {
    return { ok: false, message: `a document holds at most ${MAX_COMPONENTS} components` };
  }
  if (have.connections.length + CONNECTIONS.length > MAX_CONNECTIONS) {
    return { ok: false, message: `a document holds at most ${MAX_CONNECTIONS} connections` };
  }
  const units = bareUnits(doc.units);
  const x = (source: string): StoredExpression => ({ source, ...units });
  const nextIds = doc.mech?.nextIds ?? {};
  const el0 = peekCounter(nextIds, MECH_COUNTERS.component);
  const conn0 = peekCounter(nextIds, MECH_COUNTERS.connection);
  const ids = new Map(COMPONENTS.map((c, i) => [c.key, `${MECH_COUNTERS.component}#${el0 + i}`]));
  const components: Component[] = COMPONENTS.map((c) => ({
    id: ids.get(c.key)!,
    name: c.name,
    role: c.role,
    ...(c.terminals !== undefined ? { terminals: c.terminals.map((t) => ({ ...t })) } : {}),
    ...(c.load !== undefined
      ? {
          load: {
            current: x(c.load.current),
            ...(c.load.voltage !== undefined ? { voltage: x(c.load.voltage) } : {}),
          },
        }
      : {}),
  }));
  const connections: Connection[] = CONNECTIONS.map(([from, ft, to, tt, colour], i) => ({
    id: `${MECH_COUNTERS.connection}#${conn0 + i}`,
    from: { component: ids.get(from)!, terminal: ft },
    to: { component: ids.get(to)!, terminal: tt },
    colour,
    number: String(have.connections.length + i + 1),
  }));
  return {
    ok: true,
    command: {
      type: 'setElectrical',
      electrical: {
        ...have,
        components: [...have.components, ...components],
        connections: [...have.connections, ...connections],
      },
    },
    label: 'Add the cable trainer’s electrical system',
    componentIds: components.map((c) => c.id),
    connectionIds: connections.map((c) => c.id),
  };
}
