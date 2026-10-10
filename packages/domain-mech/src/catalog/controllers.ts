// Built-in motor controller entries (T9.2b; ADR 0017 decision 7; T9.0c's representative parts).
// Typical published values, every one `verified: false`. The bus voltage stored is the absolute
// maximum where the maker gives one, since a check compares it with the pack's full voltage plus
// the regenerative rise. No maker publishes the loss model (fixed loss, conduction resistance,
// switching time) that T9.0b's simulation uses, so those fields are `unknown` here, named, and a
// record that needs them says so. Ratings are SI, dimensions millimetres, mass kilograms.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const degC = (v: number) => v + 273.15;

const NO_LOSS_DATA = {
  fixedLoss: { unknown: true },
  legResistance: { unknown: true },
  switchingTime: { unknown: true },
} as const;

/** The built-in controllers, every version. */
export const CONTROLLER_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'controller/flipsky-75100-v2',
    version: 1,
    family: 'controller',
    fieldsVersion: 2,
    maker: 'Flipsky',
    partNumber: '75100 V2.0 (aluminium PCB)',
    description: 'VESC-based FOC controller, 75 V class',
    ratings: {
      minBusVoltage: { value: 14 },
      maxBusVoltage: { value: 75, estimated: true },
      continuousPhaseCurrent: {
        value: 100,
        basis: 'seller figure; whether phase or battery current, and the cooling, not stated',
      },
      peakPhaseCurrent: { value: 120, basis: 'burst, seller figure; duration not stated' },
      regeneration: { text: 'to bus only' },
      feedback: { text: 'ABI incremental, Hall, AS5047, AS5048A' },
      communication: { text: 'USB, CAN, UART' },
      ...NO_LOSS_DATA,
    },
    dimensions: { length: { value: 103 }, width: { value: 58 }, height: { value: 27.7 } },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title:
          'Flipsky, 75100 V2.0 product page (read through a search summary for T9.0c, not confirmed)',
        url: 'https://theflipsky.com/product/flipsky-75100-v2-0-with-aluminum-pcb-with-power-switch-button-based-on-vesc-for-electric-skateboard-scooter-ebike-speed-controller/',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'The seller lists 14 to 84 V (4 to 20S). The maximum stored is 75 V, the voltage class in the name, marked estimated, until the maker states an absolute maximum. VESC firmware returns braking energy to the battery; there is no chopper output, so a pack that cannot accept it needs an external chopper or a regeneration current limit.',
  },
  {
    id: 'controller/mjbots-moteus-n1',
    version: 1,
    family: 'controller',
    fieldsVersion: 2,
    maker: 'mjbots',
    partNumber: 'moteus-n1',
    description: 'FOC servo controller with integrated absolute magnetic encoder',
    ratings: {
      minBusVoltage: { value: 10 },
      maxBusVoltage: { value: 54 },
      continuousPhaseCurrent: {
        value: 9,
        basis: 'without thermal management; 26 A with thermal management',
      },
      peakPhaseCurrent: { value: 100, basis: 'peak; duration not stated' },
      peakPower: { value: 2000, basis: 'peak electrical power at 36 V' },
      regeneration: { unknown: true },
      loopRate: { value: 15000 },
      pwmFrequency: { value: 15000 },
      maxElectricalFrequency: { value: 2000 },
      feedback: {
        text: 'integrated absolute magnetic encoder; auxiliary SPI, quadrature, Hall, I2C, UART',
      },
      communication: { text: 'CAN-FD, 5 Mbit/s' },
      minOperatingTemperature: { value: degC(-40) },
      maxOperatingTemperature: { value: degC(85) },
      ...NO_LOSS_DATA,
    },
    dimensions: { length: { value: 46 }, width: { value: 46 }, height: { value: 8 } },
    mass: { value: 0.0146 },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'mjbots, moteus-n1 product page',
        url: 'https://mjbots.com/products/moteus-n1',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'At most 12S. The control rate is 15 to 30 kHz and the PWM rate 15 to 60 kHz; the low ends are stored. Regeneration and braking are not stated.',
  },
  {
    id: 'controller/odrive-pro',
    version: 1,
    family: 'controller',
    fieldsVersion: 2,
    maker: 'ODrive Robotics',
    partNumber: 'ODrive Pro',
    description: 'Single-axis FOC controller, 58 V',
    ratings: {
      minBusVoltage: { value: 15 },
      maxBusVoltage: { value: 58 },
      continuousPhaseCurrent: {
        value: 80,
        basis: 'typical, free air, 25 degC, phase amplitude; 100 A maximum',
      },
      peakPhaseCurrent: { value: 100, basis: '3 s with active cooling, phase amplitude' },
      peakPower: { value: 5000, basis: 'peak, from T9.0c' },
      regeneration: { unknown: true },
      feedback: { text: 'incremental, RS-485, Hall, SPI' },
      communication: { text: 'USB, CAN to 12 Mbit/s, UART, step and direction' },
      minOperatingTemperature: { value: degC(0) },
      maxOperatingTemperature: { value: degC(40) },
      ...NO_LOSS_DATA,
    },
    dimensions: { length: { value: 64 }, width: { value: 51 }, height: { value: 17.5 } },
    mass: { value: 0.14 },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'ODrive Pro datasheet',
        url: 'https://docs.odriverobotics.com/v/latest/hardware/pro-datasheet.html',
        revision: 'docs "latest"',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Mass with the full case (32 g bare board, 72 g heat spreader). There is no integrated brake resistor; how braking energy is handled (an external resistor or a supply that absorbs it) was not confirmed, so regeneration is unknown. Maximum modulation depth 99 %.',
  },
  {
    id: 'controller/odrive-s1',
    version: 1,
    family: 'controller',
    fieldsVersion: 2,
    maker: 'ODrive Robotics',
    partNumber: 'ODrive S1',
    description: 'Single-axis FOC controller, 50.5 V, with a brake resistor output',
    ratings: {
      minBusVoltage: { value: 12 },
      maxBusVoltage: { value: 50.5 },
      continuousPhaseCurrent: {
        value: 20,
        basis:
          'free air, 25 degC, phase amplitude: 20 to 40 A by bus voltage, the low end stored; 40 to 80 A with the heat spreader',
      },
      peakPhaseCurrent: { unknown: true },
      continuousPower: { value: 2000, basis: 'continuous, from T9.0c' },
      regeneration: { text: 'chopper output' },
      chopperCurrent: { unknown: true },
      minBrakeResistance: { unknown: true },
      feedback: {
        text: 'onboard magnetic encoder, incremental, RS-485, Hall, SPI (RS-485 and SPI exclusive)',
      },
      communication: { text: 'USB, CAN to 8 Mbit/s, UART, step and direction, PWM' },
      minOperatingTemperature: { value: degC(0) },
      maxOperatingTemperature: { value: degC(40) },
      ...NO_LOSS_DATA,
    },
    geometry: { kind: 'placeholder', shape: { kind: 'box' } },
    sources: [
      {
        title: 'ODrive S1 datasheet',
        url: 'https://docs.odriverobotics.com/v/latest/hardware/s1-datasheet.html',
        revision: 'docs "latest"',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'Peak current is a curve against bus voltage on the datasheet, not one number. One brake resistor per S1 on its dedicated output; the chopper current and smallest resistor were not stated. Maximum modulation depth 78 % of the bus voltage. Dimensions are in the maker CAD model, not the datasheet.',
  },
];
