// Display units of the physical kinds (README, "Display units per kind"): which units a kind can
// be shown in, which one a document shows absent a stored choice, and formatting in them. Every
// display unit's spelling parses back, in a field of its kind, to the value shown.

import type { PhysicalKind } from './dimension';
import { fixed, nonFinite, type LengthFormat } from './format';
import { GN, HP, LB, LBF } from './units';

/** The two families of default display units. */
export type UnitSystem = 'si' | 'us';

/**
 * The display unit chosen per kind, as a document will store it (`units.quantities`, ADR 0017's
 * T9.1e). A kind without an entry, or with a unit the kind does not have, takes the default.
 */
export type QuantityDisplayUnits = Partial<Readonly<Record<PhysicalKind, string>>>;

interface DisplayUnit {
  /** As written in output; parses back in a field of the kind. */
  readonly symbol: string;
  /** SI units per one display unit (for a temperature: kelvin per degree). */
  readonly si: number;
  /** Kelvin at zero of an absolute temperature scale (`°C` 273.15); absent elsewhere. */
  readonly offset?: number;
  readonly decimals: number;
}

interface KindDisplay {
  readonly units: readonly DisplayUnit[];
  readonly si: string;
  readonly us: string;
}

const IN = 0.0254;
const FT = 0.3048;
const RPM = (2 * Math.PI) / 60;

function unit(symbol: string, si: number, decimals: number, offset?: number): DisplayUnit {
  return offset === undefined ? { symbol, si, decimals } : { symbol, si, decimals, offset };
}

function display(si: string, us: string, units: readonly DisplayUnit[]): KindDisplay {
  return { units, si, us };
}

const DISPLAY: Readonly<Record<PhysicalKind, KindDisplay>> = {
  mass: display('kg', 'lb', [
    unit('kg', 1, 3),
    unit('g', 0.001, 1),
    unit('lb', LB, 3),
    unit('oz', LB / 16, 2),
  ]),
  force: display('N', 'lbf', [
    unit('N', 1, 1),
    unit('kN', 1000, 3),
    unit('lbf', LBF, 1),
    unit('ozf', LBF / 16, 2),
    unit('kgf', GN, 2),
  ]),
  torque: display('N·m', 'lbf·ft', [
    unit('N·m', 1, 2),
    unit('kN·m', 1000, 4),
    unit('lbf·ft', LBF * FT, 2),
    unit('lbf·in', LBF * IN, 1),
    unit('ozf·in', (LBF / 16) * IN, 1),
  ]),
  energy: display('J', 'J', [
    unit('J', 1, 1),
    unit('kJ', 1000, 3),
    unit('Wh', 3600, 2),
    unit('kWh', 3.6e6, 4),
  ]),
  speed: display('m/s', 'mph', [
    unit('m/s', 1, 3),
    unit('mm/s', 0.001, 1),
    unit('km/h', 1 / 3.6, 2),
    unit('ft/s', FT, 2),
    unit('mph', 0.44704, 2),
  ]),
  angularSpeed: display('rpm', 'rpm', [
    unit('rpm', RPM, 1),
    unit('rad/s', 1, 3),
    unit('deg/s', Math.PI / 180, 1),
  ]),
  acceleration: display('m/s^2', 'ft/s^2', [
    unit('m/s^2', 1, 3),
    unit('ft/s^2', FT, 2),
    unit('gn', GN, 3),
  ]),
  power: display('W', 'W', [unit('W', 1, 1), unit('kW', 1000, 3), unit('hp', HP, 3)]),
  voltage: display('V', 'V', [unit('V', 1, 2), unit('mV', 0.001, 1), unit('kV', 1000, 4)]),
  current: display('A', 'A', [unit('A', 1, 2), unit('mA', 0.001, 1)]),
  resistance: display('Ω', 'Ω', [unit('Ω', 1, 3), unit('mohm', 0.001, 1), unit('kohm', 1000, 3)]),
  inductance: display('mH', 'mH', [unit('mH', 0.001, 3), unit('H', 1, 6), unit('µH', 1e-6, 1)]),
  charge: display('Ah', 'Ah', [unit('Ah', 3600, 3), unit('C', 1, 1), unit('mAh', 3.6, 0)]),
  temperature: display('°C', '°F', [
    unit('°C', 1, 1, 273.15),
    unit('°F', 5 / 9, 1, (459.67 * 5) / 9),
    unit('K', 1, 2, 0),
  ]),
  temperatureDelta: display('K', '°F', [unit('K', 1, 1), unit('°C', 1, 1), unit('°F', 5 / 9, 1)]),
  pressure: display('MPa', 'psi', [
    unit('MPa', 1e6, 2),
    unit('Pa', 1, 0),
    unit('kPa', 1e3, 2),
    unit('GPa', 1e9, 3),
    unit('psi', LBF / IN ** 2, 0),
    unit('ksi', (1000 * LBF) / IN ** 2, 2),
    unit('bar', 1e5, 3),
  ]),
  stiffness: display('N/mm', 'lbf/in', [
    unit('N/mm', 1000, 2),
    unit('N/m', 1, 0),
    unit('lbf/in', LBF / IN, 1),
  ]),
  rotationalStiffness: display('N·m/rad', 'lbf·ft/rad', [
    unit('N·m/rad', 1, 2),
    unit('lbf·ft/rad', LBF * FT, 2),
  ]),
  inertia: display('kg·m^2', 'lb·in^2', [
    unit('kg·m^2', 1, 6),
    unit('g·cm^2', 1e-7, 1),
    unit('lb·in^2', LB * IN ** 2, 3),
  ]),
  frequency: display('Hz', 'Hz', [unit('Hz', 1, 2), unit('kHz', 1000, 4)]),
  time: display('s', 's', [
    unit('s', 1, 3),
    unit('ms', 0.001, 1),
    unit('min', 60, 2),
    unit('h', 3600, 3),
  ]),
  torqueConstant: display('N·m/A', 'N·m/A', [unit('N·m/A', 1, 4)]),
  velocityConstant: display('rpm/V', 'rpm/V', [unit('rpm/V', RPM, 1)]),
  thermalResistance: display('K/W', 'K/W', [unit('K/W', 1, 3)]),
  heatCapacity: display('J/K', 'J/K', [unit('J/K', 1, 1)]),
  linearDensity: display('kg/m', 'lb/ft', [unit('kg/m', 1, 4), unit('lb/ft', LB / FT, 4)]),
};

/** The unit system a document's length format implies: US customary for inch and foot formats. */
export function unitSystemOf(lengthFormat: LengthFormat['unit']): UnitSystem {
  return lengthFormat === 'in' ||
    lengthFormat === 'ft' ||
    lengthFormat === 'ft-in' ||
    lengthFormat === 'in-fraction'
    ? 'us'
    : 'si';
}

/** Every display unit of a kind, the SI default first. */
export function displayUnitsOf(kind: PhysicalKind): readonly string[] {
  const d = DISPLAY[kind];
  const symbols = d.units.map((u) => u.symbol);
  return [d.si, ...symbols.filter((s) => s !== d.si)];
}

/** The unit a kind is shown in when the document has no choice for it. */
export function defaultDisplayUnit(kind: PhysicalKind, system: UnitSystem): string {
  return system === 'us' ? DISPLAY[kind].us : DISPLAY[kind].si;
}

/**
 * The unit to show a kind in: the stored choice when the kind has that unit, otherwise the
 * default of the system the length format implies.
 */
export function resolveDisplayUnit(
  kind: PhysicalKind,
  preferences: QuantityDisplayUnits | undefined,
  lengthFormat: LengthFormat['unit'],
): string {
  const chosen = preferences?.[kind];
  if (chosen !== undefined && find(kind, chosen) !== undefined) return chosen;
  return defaultDisplayUnit(kind, unitSystemOf(lengthFormat));
}

function find(kind: PhysicalKind, symbol: string): DisplayUnit | undefined {
  return DISPLAY[kind]?.units.find((u) => u.symbol === symbol);
}

/** A kind's display unit by symbol, or its SI default when it has no such unit. */
function displayUnit(kind: PhysicalKind, symbol: string | undefined): DisplayUnit {
  return (
    (symbol === undefined ? undefined : find(kind, symbol)) ??
    (find(kind, DISPLAY[kind].si) as DisplayUnit)
  );
}

/** An SI value of a kind in a display unit (unknown units: the SI default). */
export function toDisplayUnit(si: number, kind: PhysicalKind, unit: string): number {
  const u = displayUnit(kind, unit);
  return (si - (u.offset ?? 0)) / u.si;
}

/** A value in a display unit of a kind, in SI (unknown units: the SI default). */
export function fromDisplayUnit(value: number, kind: PhysicalKind, unit: string): number {
  const u = displayUnit(kind, unit);
  return value * u.si + (u.offset ?? 0);
}

export interface QuantityFormat {
  /** A display unit of the kind (`displayUnitsOf`); default and fallback the SI default. */
  readonly unit?: string;
  /** Digits after the decimal point; the default depends on the unit. */
  readonly decimals?: number;
}

/**
 * Formats a physical kind's SI value: `890.0 N`, `16.23 lbf·ft`, `25.0 °C`. The output parses back
 * in a field of the same kind to the displayed value. `NaN` and infinities give `'NaN'`,
 * `'Infinity'` or `'-Infinity'`.
 */
export function formatQuantity(
  si: number,
  kind: PhysicalKind,
  format: QuantityFormat = {},
): string {
  if (!Number.isFinite(si)) return nonFinite(si);
  const u = displayUnit(kind, format.unit);
  const value = (si - (u.offset ?? 0)) / u.si;
  return `${fixed(value, format.decimals ?? u.decimals)} ${u.symbol}`;
}
