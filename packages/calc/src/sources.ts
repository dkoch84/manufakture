// The published sources the formulas cite. Each record lists the ones its method comes from, with
// the equation or table, so a reader can check the working against the book.

import type { CalcSource } from './record';

const SHIGLEY_10 = "Budynas and Nisbett, Shigley's Mechanical Engineering Design, 10th ed. (2015)";
const SHIGLEY_11 = "Budynas and Nisbett, Shigley's Mechanical Engineering Design, 11th ed. (2020)";
const ROARK = "Young and Budynas, Roark's Formulas for Stress and Strain, 7th ed. (2002)";
const PILKEY = 'Pilkey, Formulas for Stress, Strain, and Structural Matrices, 2nd ed. (2005)';

export function shigley10(locator: string): CalcSource {
  return { title: SHIGLEY_10, locator };
}

export function shigley11(locator: string): CalcSource {
  return { title: SHIGLEY_11, locator };
}

export function roark(locator: string): CalcSource {
  return { title: ROARK, locator };
}

/** Pilkey's Table 6-1 restates the curve fits of Pilkey, Peterson's Stress Concentration Factors. */
export function pilkey(locator: string): CalcSource {
  return { title: PILKEY, locator };
}

export const PETERSON: CalcSource = {
  title: "Pilkey, Peterson's Stress Concentration Factors, 2nd ed. (1997)",
  locator: 'the charts Pilkey (2005) Table 6-1 fits',
};

export function iso281(locator: string): CalcSource {
  return { title: 'ISO 281:2007, Rolling bearings: dynamic load ratings and rating life', locator };
}

export function iso76(locator: string): CalcSource {
  return { title: 'ISO 76:2006, Rolling bearings: static load ratings', locator };
}

export function vdi2230(locator: string): CalcSource {
  return {
    title: 'VDI 2230 Part 1 (2015), Systematic calculation of highly stressed bolted joints',
    locator,
  };
}

export function fedStdH28(locator: string): CalcSource {
  return { title: 'FED-STD-H28/2B, Screw-thread standards for federal services', locator };
}

export function machinerysHandbook(locator: string): CalcSource {
  return { title: "Oberg et al., Machinery's Handbook, 30th ed. (2016)", locator };
}

export function iso898(locator: string): CalcSource {
  return { title: 'ISO 898-1:2013, Mechanical properties of fasteners', locator };
}

export function nec(locator: string): CalcSource {
  return { title: 'NFPA 70, National Electrical Code (2023)', locator };
}

export function nbs100(locator: string): CalcSource {
  return { title: 'NBS Handbook 100, Copper Wire Tables (1966)', locator };
}

export function astmB258(locator: string): CalcSource {
  return { title: 'ASTM B258, Standard nominal diameters of American Wire Gauge (AWG)', locator };
}

export function incropera(locator: string): CalcSource {
  return {
    title: 'Bergman, Lavine, Incropera and DeWitt, Fundamentals of Heat and Mass Transfer, 7th ed.',
    locator,
  };
}

export function gates(locator: string): CalcSource {
  return { title: 'Gates, Synchronous belt drive design manual', locator };
}
