import { describe, expect, it } from 'vitest';
import {
  ENERGY,
  FORCE,
  LENGTH,
  PHYSICAL_KINDS,
  TEMPERATURE,
  describeDimension,
  dimensionOfKind,
  lengthQuantity,
  numberQuantity,
  spindleSpeedQuantity,
  type PhysicalKind,
  type Quantity,
} from './dimension';
import {
  evaluate,
  evaluateParsed,
  evaluateParsedQuantity,
  evaluateQuantity,
  parseLength,
  parseQuantity,
  type EvaluateOptions,
} from './evaluate';
import * as api from './index';
import { parseExpression } from './parser';
import {
  defaultDisplayUnit,
  displayUnitsOf,
  formatQuantity,
  fromDisplayUnit,
  resolveDisplayUnit,
  toDisplayUnit,
  unitSystemOf,
} from './quantities';
import { findReferences } from './references';
import type { UnitsErrorCode } from './result';
import { physicalQuantity, quantityFromSI, quantityToSI } from './si';
import { unwrap, unwrapError } from './test-helpers';
import { PHYSICAL_UNIT_NAMES } from './units';

const LBF = 4.4482216152605;
const LB = 0.45359237;
const RPM = (2 * Math.PI) / 60;

const VARIABLES: ReadonlyMap<string, Quantity> = new Map([
  ['force', physicalQuantity('force', 890)],
  ['torque', physicalQuantity('torque', 22)],
  ['omega', physicalQuantity('angularSpeed', 60)],
  ['power', physicalQuantity('power', 1320)],
  ['kt', physicalQuantity('torqueConstant', 0.5)],
  ['ambient', physicalQuantity('temperature', 298.15)],
  ['winding', physicalQuantity('temperature', 373.15)],
  ['rise', physicalQuantity('temperatureDelta', 40)],
  ['radius', lengthQuantity(25)],
  ['ratio', numberQuantity(5)],
  ['s', numberQuantity(4)],
  ['spindle', spindleSpeedQuantity(18000)],
]);

function run(
  source: string,
  expected: EvaluateOptions['expected'],
  extra: Partial<EvaluateOptions> = {},
) {
  return evaluate(source, { expected, variables: (n) => VARIABLES.get(n), ...extra });
}

function value(source: string, expected: EvaluateOptions['expected']): number {
  return unwrap(run(source, expected));
}

describe('physical units', () => {
  it.each<[string, PhysicalKind, number]>([
    // the plan's examples
    ['200 lbf', 'force', 200 * LBF],
    ['22 N*m', 'torque', 22],
    ['1.7 Ah', 'charge', 1.7 * 3600],
    ['57.6 V', 'voltage', 57.6],
    ['97.9 Wh', 'energy', 97.9 * 3600],
    // mass
    ['2 kg', 'mass', 2],
    ['500 g', 'mass', 0.5],
    ['1 lb', 'mass', LB],
    ['16 oz', 'mass', LB],
    // force
    ['3 kN', 'force', 3000],
    ['16 ozf', 'force', LBF],
    ['1 kgf', 'force', 9.80665],
    ['890N', 'force', 890],
    // torque
    ['22 Nm', 'torque', 22],
    ['22 N·m', 'torque', 22],
    ['1.5 kN*m', 'torque', 1500],
    ['10 lbf*ft', 'torque', 10 * LBF * 0.3048],
    ['10 lbf*in', 'torque', 10 * LBF * 0.0254],
    ['10 ozf*in', 'torque', (10 * LBF * 0.0254) / 16],
    // speed
    ['1.5 m/s', 'speed', 1.5],
    ['1500 mm/s', 'speed', 1.5],
    ['36 km/h', 'speed', 10],
    ['10 ft/s', 'speed', 3.048],
    ['10 mph', 'speed', 4.4704],
    ['1000mm/min', 'speed', 1 / 60],
    // angular speed
    ['60 rad/s', 'angularSpeed', 60],
    ['573 rpm', 'angularSpeed', 573 * RPM],
    ['90 deg/s', 'angularSpeed', Math.PI / 2],
    ['90°/s', 'angularSpeed', Math.PI / 2],
    // acceleration
    ['9.81 m/s^2', 'acceleration', 9.81],
    ['1 gn', 'acceleration', 9.80665],
    ['32.2 ft/s^2', 'acceleration', 32.2 * 0.3048],
    // power and energy
    ['1.3 kW', 'power', 1300],
    ['1 hp', 'power', 745.6998715822702],
    ['500 W', 'power', 500],
    ['4.8 kJ', 'energy', 4800],
    ['1 kWh', 'energy', 3.6e6],
    ['530 J', 'energy', 530],
    // electrical
    ['250 mV', 'voltage', 0.25],
    ['1 kV', 'voltage', 1000],
    ['45 A', 'current', 45],
    ['500 mA', 'current', 0.5],
    ['0.08 ohm', 'resistance', 0.08],
    ['0.08 Ω', 'resistance', 0.08],
    ['0.08Ω', 'resistance', 0.08],
    ['80 mohm', 'resistance', 0.08],
    ['4.7 kohm', 'resistance', 4700],
    ['4.7 kΩ', 'resistance', 4700],
    ['4.7kΩ', 'resistance', 4700],
    ['80 mΩ', 'resistance', 0.08],
    ['2 H', 'inductance', 2],
    ['150 mH', 'inductance', 0.15],
    ['220 uH', 'inductance', 220e-6],
    ['220 µH', 'inductance', 220e-6],
    ['220 μH', 'inductance', 220e-6],
    ['10 C', 'charge', 10],
    ['2500 mAh', 'charge', 9000],
    // pressure and stress
    ['101325 Pa', 'pressure', 101325],
    ['100 kPa', 'pressure', 1e5],
    ['415 MPa', 'pressure', 415e6],
    ['200 GPa', 'pressure', 200e9],
    ['1 psi', 'pressure', LBF / 0.0254 ** 2],
    ['1 ksi', 'pressure', (1000 * LBF) / 0.0254 ** 2],
    ['1 bar', 'pressure', 1e5],
    ['100 N/mm^2', 'pressure', 100e6],
    // stiffness and inertia
    ['500 N/m', 'stiffness', 500],
    ['5 N/mm', 'stiffness', 5000],
    ['10 lbf/in', 'stiffness', (10 * LBF) / 0.0254],
    ['0.5 kg*m^2', 'inertia', 0.5],
    ['1000 g*cm^2', 'inertia', 1e-4],
    ['1 lb*in^2', 'inertia', LB * 0.0254 ** 2],
    ['0.5 kg·m^2', 'inertia', 0.5],
    ['50 N*m/rad', 'rotationalStiffness', 50],
    // frequency and time
    ['50 Hz', 'frequency', 50],
    ['2 kHz', 'frequency', 2000],
    ['50/s', 'frequency', 50],
    ['12000/min', 'frequency', 200],
    ['30 s', 'time', 30],
    ['250 ms', 'time', 0.25],
    ['2 min', 'time', 120],
    ['1.5 h', 'time', 5400],
    // derived kinds
    ['0.5 N*m/A', 'torqueConstant', 0.5],
    ['100 rpm/V', 'velocityConstant', 100 * RPM],
    ['2 K/W', 'thermalResistance', 2],
    ['2 degC/W', 'thermalResistance', 2],
    ['900 J/K', 'heatCapacity', 900],
    ['0.2 kg/m', 'linearDensity', 0.2],
    ['1 lb/ft', 'linearDensity', LB / 0.3048],
  ])('%s is %s %d (SI)', (source, kind, expected) => {
    const digits = 9 - Math.max(0, Math.round(Math.log10(Math.abs(expected))));
    expect(value(source, kind)).toBeCloseTo(expected, digits);
  });

  it('gives exact SI values for exact inputs', () => {
    expect(value('1 kgf', 'force')).toBe(9.80665);
    expect(value('1 gn', 'acceleration')).toBe(9.80665);
    expect(value('1 mph', 'speed')).toBe(0.44704);
    expect(value('10 µH', 'inductance')).toBe(1e-5);
    expect(value('250 mV', 'voltage')).toBe(0.25);
    expect(value('-3 kN', 'force')).toBe(-3000);
    expect(value('2 * 1 kgf', 'force')).toBe(2 * 9.80665);
    expect(value('22 N*m / 25 mm', 'force')).toBe(880);
    expect(value('1.7 Ah', 'charge')).toBe(1.7 * 3600);
    expect(value('22 N*m', 'torque')).toBe(22);
    expect(value('9.81 m/s^2', 'acceleration')).toBe(9.81);
    expect(value('890 N', 'force')).toBe(890);
    expect(value('415 MPa', 'pressure')).toBe(415e6);
    expect(value('1.5 m/s', 'speed')).toBe(1.5);
  });

  it('reads compound units with parentheses, middle dots and negative exponents', () => {
    const conductivity = unwrap(evaluateQuantity('20 W/(m*degC)'));
    expect(describeDimension(conductivity.dimension)).toBe(
      'a value of dimension length*time^-3*mass*temperature^-1',
    );
    expect(quantityToSI(conductivity)).toBeCloseTo(20, 12);
    expect(value('2 kg*m^-1', 'linearDensity')).toBeCloseTo(2, 12);
    expect(value('22 N·m', 'energy')).toBe(22);
  });

  it('lists every unit spelling of the ADR', () => {
    for (const name of [
      'kg',
      'lbf',
      'Nm',
      'mph',
      'gn',
      'hp',
      'kWh',
      'Ω',
      'µH',
      'mAh',
      'degF',
      'ksi',
      'kHz',
      'ms',
      'h',
    ]) {
      expect(PHYSICAL_UNIT_NAMES).toContain(name);
    }
  });

  it('keeps g the gram and min, mm and ms apart', () => {
    expect(value('1 g', 'mass')).toBe(0.001);
    expect(value('1 gn', 'acceleration')).toBe(9.80665);
    expect(value('1 min', 'time')).toBe(60);
    expect(value('1 ms', 'time')).toBe(0.001);
    expect(value('1 mm/s', 'speed')).toBeCloseTo(0.001, 15);
  });

  it('is case-sensitive for the new units', () => {
    expect(unwrapError(run('5MA', 'current')).code).toBe('unknown-unit');
    expect(unwrapError(run('5mpa', 'pressure')).code).toBe('unknown-unit');
    expect(value('5 h', 'time')).toBe(18000);
    expect(value('5 H', 'inductance')).toBe(5);
    // the old units stay case-insensitive
    expect(value('5 MIN', 'time')).toBe(300);
    expect(unwrap(parseLength('5 MM'))).toBe(5);
  });
});

describe('dimension checking', () => {
  it.each<[string, PhysicalKind, number]>([
    ['22 N*m / 25 mm', 'force', 880],
    ['#torque / #radius', 'force', 880],
    ['#force * #radius', 'torque', 22.25],
    ['1.5 m/s / 25 mm', 'angularSpeed', 60],
    ['22 N*m * 60 rad/s', 'power', 1320],
    ['#torque * #omega', 'power', 1320],
    ['22 N*m * 573 rpm', 'power', 22 * 573 * RPM],
    ['#power / #torque', 'angularSpeed', 60],
    ['57.6 V * 1.7 Ah', 'energy', 57.6 * 1.7 * 3600],
    ['22 N*m / (0.5 N*m/A)', 'current', 44],
    ['#torque / #kt', 'current', 44],
    ['(44 A)^2 * 0.08 ohm', 'power', 154.88],
    ['160 W * 30 s', 'energy', 4800],
    ['200 lbf * 0.6 m', 'energy', 200 * LBF * 0.6],
    ['57.6 V / 0.08 ohm', 'current', 720],
    ['2 kg * 9.81 m/s^2', 'force', 19.62],
    ['890 N / (25 mm * 2 mm)', 'pressure', 17.8e6],
    ['890 N / 5 N/mm', 'time', NaN],
    ['2 * #force', 'force', 1780],
    ['#force / #ratio', 'force', 178],
    ['#force + 10 N', 'force', 900],
    ['max(#force, 1 kN)', 'force', 1000],
    ['sqrt(4 m^2) * 1 N', 'torque', 2],
  ])('%s is %s %d', (source, kind, expected) => {
    if (Number.isNaN(expected)) {
      expect(unwrapError(run(source, kind)).code).toBe('dimension');
      return;
    }
    expect(value(source, kind)).toBeCloseTo(expected, 6);
  });

  it.each<[string, PhysicalKind, UnitsErrorCode, string, string]>([
    ['22 N*m', 'force', 'dimension', 'Expected a force but got a torque or an energy', '22 N*m'],
    [
      '#torque + #force',
      'torque',
      'dimension',
      'Cannot add a torque or an energy and a force',
      '#torque + #force',
    ],
    ['5 kg', 'force', 'dimension', 'Expected a force but got a mass', '5 kg'],
    ['5 m', 'speed', 'dimension', 'Expected a speed but got a length', '5 m'],
    ['5 A', 'voltage', 'dimension', 'Expected a voltage but got a current', '5 A'],
    ['200', 'force', 'dimension', 'A force needs a unit: write 200 N or 200 lbf', '200'],
    ['22', 'torque', 'dimension', 'A torque needs a unit: write 22 N·m or 22 lbf·ft', '22'],
    ['25', 'temperature', 'dimension', 'A temperature needs a unit: write 25 °C or 25 °F', '25'],
    ['2 * 3', 'voltage', 'dimension', 'A voltage needs a unit: write 6 V', '2 * 3'],
    ['#force + 5', 'force', 'dimension', 'A force needs a unit: write 5 N or 5 lbf', '5'],
    ['5 + #force', 'force', 'dimension', 'A force needs a unit: write 5 N or 5 lbf', '5'],
    ['max(#force, 5)', 'force', 'dimension', 'A force needs a unit: write 5 N or 5 lbf', '5'],
    ['#ratio', 'force', 'dimension', 'A force needs a unit: write 5 N or 5 lbf', '#ratio'],
    ['#force * sin(30)', 'force', 'dimension', 'An angle needs a unit: write 30° or 30 rad', '30'],
    [
      '600 rpm',
      'frequency',
      'dimension',
      'An angular speed is not a frequency: write the frequency in Hz, or divide by (2*pi)rad',
      '600 rpm',
    ],
    ['5 N^x', 'force', 'unknown-variable', "Unknown variable 'x'", 'x'],
  ])('%s in a %s field: %s "%s"', (source, kind, code, message, highlighted) => {
    const error = unwrapError(run(source, kind));
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(source.slice(error.start, error.end)).toBe(highlighted);
  });

  it('accepts trig with an angle unit and a frequency from an angular speed over 2 pi rad', () => {
    expect(value('#force * sin(30°)', 'force')).toBeCloseTo(445, 9);
    expect(value('#omega / (2*pi)rad', 'frequency')).toBeCloseTo(60 / (2 * Math.PI), 12);
    expect(value('10 Hz', 'angularSpeed')).toBeCloseTo(10, 12);
  });

  it('shares a dimension between torque and energy, the kind decides', () => {
    expect(dimensionOfKind('torque')).toEqual(ENERGY);
    expect(value('22 N*m', 'energy')).toBe(22);
    expect(value('530 J', 'torque')).toBe(530);
  });

  it('rounds physical values in SI', () => {
    expect(value('round(890.4 N)', 'force')).toBe(890);
    expect(value('round(#force, 100 N)', 'force')).toBeCloseTo(900, 9);
  });
});

describe('temperature', () => {
  it.each<[string, 'temperature' | 'temperatureDelta', number]>([
    ['25degC', 'temperature', 298.15],
    ['25degC', 'temperatureDelta', 25],
    ['25 °C', 'temperature', 298.15],
    ['25°C', 'temperatureDelta', 25],
    ['77degF', 'temperature', 298.15],
    ['77 °F', 'temperatureDelta', (77 * 5) / 9],
    ['9 °F', 'temperatureDelta', 5],
    ['300 K', 'temperature', 300],
    ['300 K', 'temperatureDelta', 300],
    ['-40degC', 'temperature', 233.15],
    ['-40degF', 'temperature', 233.15],
    ['(-40)degC', 'temperature', 233.15],
    ['#ambient', 'temperature', 298.15],
    ['#ambient + 40 K', 'temperature', 338.15],
    ['#ambient + 40degC', 'temperature', 338.15],
    ['#ambient + 72degF', 'temperature', 338.15],
    ['40degC + #ambient', 'temperature', 338.15],
    ['#ambient + #rise', 'temperature', 338.15],
    ['#ambient - 5degC', 'temperature', 293.15],
    ['#ambient - 20degC', 'temperatureDelta', 5],
    ['#winding - #ambient', 'temperatureDelta', 75],
    ['20degC + 5degC', 'temperatureDelta', 25],
    ['#ambient + (20degC + 5degC)', 'temperature', 323.15],
    ['30degC - 20degC', 'temperatureDelta', 10],
    ['80degC - 20degC', 'temperatureDelta', 60],
    ['#ambient + (80degC - 20degC)', 'temperature', 358.15],
    ['68degF - 20degC', 'temperatureDelta', 0],
    ['300 K - 20degC', 'temperatureDelta', 6.85],
    ['25 ℃', 'temperature', 298.15],
    ['77℉', 'temperature', 298.15],
    ['25degC - 5 K', 'temperatureDelta', 20],
    ['25degC - 5 K', 'temperature', 293.15],
    ['2 * 5degC', 'temperatureDelta', 10],
    ['160 W * 2 K/W', 'temperatureDelta', 320],
    ['#ambient + 160 W * 2 K/W', 'temperature', 618.15],
    ['max(#ambient, 30degC)', 'temperature', 303.15],
    ['max(#rise, 5 K)', 'temperatureDelta', 40],
    ['round(#ambient, 5 K)', 'temperature', 300],
  ])('%s in a %s field is %d K', (source, kind, expected) => {
    expect(value(source, kind)).toBeCloseTo(expected, 9);
  });

  it.each<[string, 'temperature' | 'temperatureDelta', string]>([
    [
      '#ambient + #winding',
      'temperature',
      'Cannot add two absolute temperatures: add a temperature difference, or subtract them',
    ],
    [
      '2 * #ambient',
      'temperature',
      'Cannot multiply an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)',
    ],
    [
      '#ambient / 2',
      'temperature',
      'Cannot divide an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)',
    ],
    [
      '#ambient^2',
      'temperature',
      'Cannot raise an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)',
    ],
    [
      '-#ambient',
      'temperature',
      'Cannot negate an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)',
    ],
    [
      '#rise - #ambient',
      'temperatureDelta',
      'Cannot subtract an absolute temperature from a temperature difference',
    ],
    [
      '#winding - #ambient',
      'temperature',
      'Expected a temperature but got a temperature difference: add it to a temperature',
    ],
    [
      '2 * 25degC',
      'temperature',
      'Expected a temperature but got a temperature difference: add it to a temperature',
    ],
    [
      '#ambient',
      'temperatureDelta',
      'Expected a temperature difference but got an absolute temperature: subtract another temperature from it',
    ],
    [
      '#ambient + 5 K',
      'temperatureDelta',
      'Expected a temperature difference but got an absolute temperature: subtract another temperature from it',
    ],
    [
      'sqrt(#ambient * 1 K)',
      'temperature',
      'Cannot multiply an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)',
    ],
    ['abs(#ambient)', 'temperature', 'abs() cannot take an absolute temperature'],
    [
      'max(#ambient, #rise)',
      'temperature',
      'max() cannot compare an absolute temperature with a temperature difference',
    ],
  ])('%s in a %s field: %s', (source, kind, message) => {
    const error = unwrapError(run(source, kind));
    expect(error.code).toBe('dimension');
    expect(error.message).toBe(message);
  });

  it('treats a temperature unit in a compound unit as a difference', () => {
    expect(value('2 degF/W', 'thermalResistance')).toBeCloseTo(10 / 9, 12);
    expect(value('900 J/degC', 'heatCapacity')).toBe(900);
  });

  it('keeps a lone °, and ° with other letters, the degree of angle', () => {
    expect(unwrap(evaluate('30°', { expected: 'angle' }))).toBeCloseTo(Math.PI / 6, 12);
    expect(unwrapError(evaluate('30°Cx', { expected: 'angle' })).code).toBe('syntax');
  });

  it('marks a lone degC value absolute outside a temperature field', () => {
    const q = unwrap(evaluateQuantity('25degC'));
    expect(q).toEqual({ value: 298.15, dimension: TEMPERATURE, absolute: true });
    expect(unwrap(evaluateQuantity('5 K'))).toEqual({ value: 5, dimension: TEMPERATURE });
    expect(physicalQuantity('temperature', 300)).toEqual({
      value: 300,
      dimension: TEMPERATURE,
      absolute: true,
    });
    expect(physicalQuantity('temperatureDelta', 5)).toEqual({
      value: 5,
      dimension: TEMPERATURE,
      absolute: false,
    });
    expect(unwrap(evaluateQuantity('30degC - 20degC'))).toEqual({
      value: 10,
      dimension: TEMPERATURE,
      absolute: false,
    });
    expect(unwrap(evaluateQuantity('2 * 5degC'))).toEqual({
      value: 10,
      dimension: TEMPERATURE,
      absolute: false,
    });
  });
});

describe('two temperature literals (ADR 0017: absolute minus absolute is a difference)', () => {
  it('makes a literal difference a difference usable as one', () => {
    const rise = unwrap(evaluateQuantity('80degC - 20degC'));
    expect(rise).toEqual({ value: 60, dimension: TEMPERATURE, absolute: false });
    const vars = new Map<string, Quantity>([
      ['rise', rise],
      ['ambient', physicalQuantity('temperature', 293.15)],
      ['heatCapacity', physicalQuantity('heatCapacity', 900)],
    ]);
    const lookup = (n: string) => vars.get(n);
    expect(
      unwrap(evaluate('#ambient + #rise', { expected: 'temperature', variables: lookup })),
    ).toBeCloseTo(353.15, 9);
    expect(
      unwrap(evaluate('#heatCapacity * #rise', { expected: 'energy', variables: lookup })),
    ).toBeCloseTo(54000, 6);
    expect(
      unwrapError(evaluate('#rise', { expected: 'temperature', variables: lookup })).message,
    ).toBe('Expected a temperature but got a temperature difference: add it to a temperature');
  });

  it.each(['30degC - 20degC', '20degC + 5degC', '25degC + 25degC'])(
    'refuses %s in a temperature field',
    (source) => {
      expect(unwrapError(run(source, 'temperature')).message).toBe(
        'Expected a temperature but got a temperature difference: add it to a temperature',
      );
    },
  );

  it('keeps the flexible reading of mixed forms', () => {
    expect(value('#ambient - 20degC', 'temperatureDelta')).toBeCloseTo(5, 9);
    expect(value('#ambient - 5degC', 'temperature')).toBeCloseTo(293.15, 9);
    expect(value('25degC - 5 K', 'temperature')).toBeCloseTo(293.15, 9);
    expect(value('25degC - 5 K', 'temperatureDelta')).toBeCloseTo(20, 9);
  });
});

describe('physical fields and the old readings', () => {
  it('keeps the old reading of compounds after old units outside physical fields', () => {
    const vars = (n: string) => VARIABLES.get(n);
    // `5 m/s` divides 5 m by the variable s (4) in a length field, as it always did.
    expect(unwrap(evaluate('5 m/s', { expected: 'length', variables: vars }))).toBe(1250);
    expect(unwrap(evaluate('5 m/s', { expected: 'speed', variables: vars }))).toBe(5);
    // `2mm^2` is (2 mm)^2 outside, 2 mm² inside.
    expect(unwrap(evaluateQuantity('2mm^2')).value).toBe(4);
    expect(unwrap(evaluateQuantity('2mm^2', { physical: true })).value).toBe(2);
    // `rpm` is a spindle speed outside.
    expect(unwrap(evaluate('18000 rpm', { expected: 'spindleSpeed' }))).toBe(18000);
    expect(value('18000 rpm', 'angularSpeed')).toBeCloseTo(18000 * RPM, 9);
  });

  it('reads compounds after new units everywhere', () => {
    expect(unwrap(evaluateQuantity('22 N*m')).dimension).toEqual(ENERGY);
    expect(quantityToSI(unwrap(evaluateQuantity('22 N*m')))).toBe(22);
  });

  it('needs no spaces in a compound and none around it', () => {
    // with spaces, `*` and `/` are arithmetic again
    expect(unwrapError(run('22 N * m', 'torque')).message).toBe("Unknown variable 'm'");
    expect(value('5 m / s', 'length')).toBe(1250);
  });

  it('binds a compound to its number', () => {
    // 2 divided by (4 m/s) is half a second per metre
    const q = unwrap(evaluateQuantity('2 / 4 m/s', { physical: true }));
    expect(quantityToSI(q)).toBeCloseTo(0.5, 12);
    expect(value('100 N / 2 mm^2', 'pressure')).toBe(50e6);
  });

  it('reports a physical field reference-free for per-second compounds', () => {
    expect(unwrap(findReferences('5 m/s'))).toHaveLength(1);
    expect(unwrap(findReferences('5 m/s', { physical: true }))).toHaveLength(0);
    expect(unwrap(findReferences('22 N*m'))).toHaveLength(0);
  });

  it('refuses an AST parsed for the other mode when the mode matters', () => {
    const legacy = unwrap(parseExpression('5 m/s'));
    const error = unwrapError(evaluateParsed(legacy, { expected: 'speed' }));
    expect(error.code).toBe('syntax');
    const physical = unwrap(parseExpression('5 m/s', { physical: true }));
    expect(unwrap(evaluateParsed(physical, { expected: 'speed' }))).toBe(5);
    expect(unwrapError(evaluateParsedQuantity(physical)).code).toBe('syntax');
    // an expression that reads the same either way works in both
    const plain = unwrap(parseExpression('22 N*m'));
    expect(plain.parsedPhysical).toBeUndefined();
    expect(unwrap(evaluateParsed(plain, { expected: 'torque' }))).toBe(22);
    // the mode is a field of the root, so a copied tree keeps it
    const copied = JSON.parse(JSON.stringify(physical)) as typeof physical;
    expect(copied.parsedPhysical).toBe(true);
    expect(unwrap(evaluateParsed(copied, { expected: 'speed' }))).toBe(5);
    expect(
      unwrapError(evaluateParsed(JSON.parse(JSON.stringify(legacy)), { expected: 'speed' })).code,
    ).toBe('syntax');
  });

  it('leaves number fields and geometric kinds alone in physical mode, without display units', () => {
    expect(value('0.85', 'number')).toBe(0.85);
    expect(unwrap(evaluate('25 mm', { expected: 'length', physical: true }))).toBe(25);
    expect(unwrapError(evaluate('25', { expected: 'length', physical: true })).message).toBe(
      'A length needs a unit: write 25 mm or 25 in',
    );
  });

  it('parses a fraction or mixed number before a new unit', () => {
    expect(value('1/2 kg', 'mass')).toBe(0.5);
    expect(value('4-1/2 lbf', 'force')).toBeCloseTo(4.5 * LBF, 12);
    expect(value('1/2/s', 'frequency')).toBe(0.5);
  });

  it('reads a time kind in seconds', () => {
    expect(value('1.5 min + 30 s', 'time')).toBe(120);
  });
});

describe('SI conversion', () => {
  it('round-trips a quantity through SI', () => {
    for (const kind of PHYSICAL_KINDS) {
      const q = physicalQuantity(kind, 12.5);
      expect(quantityToSI(q)).toBeCloseTo(12.5, 12);
      expect(quantityFromSI(12.5, dimensionOfKind(kind)).value).toBe(q.value);
    }
  });

  it('keeps lengths in millimetres internally', () => {
    expect(quantityToSI(lengthQuantity(25))).toBe(0.025);
    expect(physicalQuantity('force', 1).dimension).toEqual(FORCE);
    expect(quantityFromSI(1, LENGTH).value).toBe(1000);
  });

  it('exports the physical API from the package root', () => {
    expect(api.parseQuantity).toBe(parseQuantity);
    expect(api.formatQuantity).toBe(formatQuantity);
    expect(api.physicalQuantity).toBe(physicalQuantity);
    expect(api.PHYSICAL_KINDS).toHaveLength(26);
    expect(unwrap(parseQuantity('200 lbf', 'force'))).toBeCloseTo(889.6443230521, 9);
  });
});

describe('display units', () => {
  it('follows the length format absent a choice', () => {
    expect(unitSystemOf('mm')).toBe('si');
    expect(unitSystemOf('m')).toBe('si');
    expect(unitSystemOf('in')).toBe('us');
    expect(unitSystemOf('ft-in')).toBe('us');
    expect(unitSystemOf('in-fraction')).toBe('us');
    expect(resolveDisplayUnit('force', undefined, 'mm')).toBe('N');
    expect(resolveDisplayUnit('force', undefined, 'ft-in')).toBe('lbf');
    expect(resolveDisplayUnit('torque', undefined, 'in')).toBe('lbf·ft');
    expect(resolveDisplayUnit('pressure', undefined, 'in-fraction')).toBe('psi');
    expect(resolveDisplayUnit('speed', undefined, 'ft')).toBe('mph');
    expect(resolveDisplayUnit('temperature', undefined, 'in')).toBe('°F');
    expect(resolveDisplayUnit('temperature', undefined, 'cm')).toBe('°C');
  });

  it('takes a stored choice when the kind has that unit', () => {
    expect(resolveDisplayUnit('force', { force: 'kN' }, 'in')).toBe('kN');
    expect(resolveDisplayUnit('force', { force: 'psi' }, 'in')).toBe('lbf');
    expect(resolveDisplayUnit('mass', { force: 'kN' }, 'mm')).toBe('kg');
  });

  it('lists every kind with its SI default first', () => {
    for (const kind of PHYSICAL_KINDS) {
      const units = displayUnitsOf(kind);
      expect(units[0]).toBe(defaultDisplayUnit(kind, 'si'));
      expect(units).toContain(defaultDisplayUnit(kind, 'us'));
    }
  });

  it.each<[number, PhysicalKind, string | undefined, string]>([
    [890, 'force', undefined, '890.0 N'],
    [890, 'force', 'lbf', '200.1 lbf'],
    [22, 'torque', 'lbf·ft', '16.23 lbf·ft'],
    [22, 'torque', undefined, '22.00 N·m'],
    [298.15, 'temperature', undefined, '25.0 °C'],
    [298.15, 'temperature', '°F', '77.0 °F'],
    [5, 'temperatureDelta', '°F', '9.0 °F'],
    [60, 'angularSpeed', undefined, '573.0 rpm'],
    [1.5, 'speed', 'mph', '3.36 mph'],
    [0.15, 'inductance', undefined, '150.000 mH'],
    [6120, 'charge', undefined, '1.700 Ah'],
    [415e6, 'pressure', undefined, '415.00 MPa'],
    [0.08, 'resistance', undefined, '0.080 Ω'],
    [-0.0001, 'force', undefined, '0.0 N'],
    [NaN, 'force', undefined, 'NaN'],
    [890, 'force', 'nonsense', '890.0 N'],
  ])('formats %d %s in %s as %s', (si, kind, unit, text) => {
    expect(formatQuantity(si, kind, unit === undefined ? {} : { unit })).toBe(text);
  });

  it('converts to and from display units', () => {
    expect(toDisplayUnit(890, 'force', 'lbf')).toBeCloseTo(200.08, 2);
    expect(fromDisplayUnit(200, 'force', 'lbf')).toBeCloseTo(889.64, 2);
    expect(toDisplayUnit(298.15, 'temperature', '°F')).toBeCloseTo(77, 12);
    expect(fromDisplayUnit(77, 'temperature', '°F')).toBeCloseTo(298.15, 12);
    expect(fromDisplayUnit(9, 'temperatureDelta', '°F')).toBeCloseTo(5, 12);
  });

  it('round-trips every display unit of every kind', () => {
    const samples = [0, 1, -3.25, 12.5, 890, 0.0123, 1234567];
    for (const kind of PHYSICAL_KINDS) {
      for (const unit of displayUnitsOf(kind)) {
        for (const sample of samples) {
          const si = fromDisplayUnit(sample, kind, unit);
          const text = formatQuantity(si, kind, { unit, decimals: 6 });
          const parsed = parseQuantity(text, kind);
          expect(parsed.ok, `${kind} ${text}`).toBe(true);
          const shown = Number(text.split(' ')[0]);
          expect(fromDisplayUnit(shown, kind, unit), `${kind} ${text}`).toBeCloseTo(
            unwrap(parsed),
            Math.max(0, 6 - Math.ceil(Math.log10(Math.abs(unwrap(parsed)) + 1))),
          );
          expect(formatQuantity(unwrap(parsed), kind, { unit, decimals: 6 })).toBe(text);
        }
      }
    }
  });
});
