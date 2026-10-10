// Built-in gear entries (T9.2d; ADR 0017 decision 7; T9.0c's field list for gears). Typical
// published values, every one `verified: false`: KHK's US catalogue pages, read through a
// summarising fetch. A module 1 spur pair in carbon steel (20 and 60 teeth, a 3:1 stage) and the
// moulded acetal 20-tooth pinion of the same module, whose rating is a sixth of the steel one's.
// KHK states two allowable torques: bending strength (`ratedTorque`) and surface durability
// (`surfaceTorque`), each under KHK's own calculation conditions. Ratings are SI (N*m), dimensions
// millimetres (bore as `innerDiameter`, face width as `width`), mass kilograms. Nothing here says a
// gear is fit for a design: the checks state margins.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';

const KHK_STEEL_NOTE =
  'Pitch diameter is module x teeth. Backlash 0.08 to 0.18 mm as a pair. KHK computes the allowable torques under its own stated conditions (speed, life, lubrication, load direction), which are in its technical reference rather than on the product page; check them before relying on either. Surface durability, not bending, limits these soft (under 194 HB) gears.';

/** The built-in gears, every version. */
export const GEAR_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'gear/khk-ds1-20',
    version: 1,
    family: 'gear',
    fieldsVersion: 2,
    maker: 'KHK',
    partNumber: 'DS1-20',
    description: 'Injection-moulded acetal spur gear, module 1, 20 teeth, 6 mm face',
    ratings: {
      teeth: { value: 20 },
      pressureAngle: { value: 20 },
      helixAngle: { value: 0 },
      ratedTorque: {
        value: 0.96,
        basis: 'allowable torque, bending strength; conditions not stated on the page',
      },
      material: { text: 'Duracon acetal (M90-44)' },
      hardness: { text: '110 to 120 HRR' },
      quality: { text: 'JIS grade N12 (JIS B1702-1:1998)' },
    },
    dimensions: {
      module: { value: 1 },
      outerDiameter: { value: 22 },
      innerDiameter: { value: 5 },
      width: { value: 6 },
    },
    mass: { value: 0.00285 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title:
          'KHK Gears (US catalogue), DS1-20 injection molded spur gear (read through a summarising fetch)',
        url: 'https://catalog.khkgears.us/item/spur-gears/injection-molded-spur-gears-ds/ds1-20',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Hub 11.7 mm, total length 12 mm, backlash 0 to 0.60 mm. A plastic gear's strength falls with temperature and depends on lubrication; no surface durability rating is given. Pitch diameter 20 mm.",
  },
  {
    id: 'gear/khk-ss1-20',
    version: 1,
    family: 'gear',
    fieldsVersion: 2,
    maker: 'KHK',
    partNumber: 'SS1-20',
    description: 'Carbon steel spur gear, module 1, 20 teeth, 10 mm face, with hub',
    ratings: {
      teeth: { value: 20 },
      pressureAngle: { value: 20 },
      helixAngle: { value: 0 },
      ratedTorque: { value: 5.75, basis: 'allowable torque, bending strength (KHK conditions)' },
      surfaceTorque: {
        value: 0.33,
        basis: 'allowable torque, surface durability (KHK conditions)',
      },
      material: { text: 'S45C (AISI 1045) carbon steel, black oxide' },
      hardness: { text: 'under 194 HB' },
      quality: { text: 'JIS grade N8 (JIS B1702-1:1998)' },
    },
    dimensions: {
      module: { value: 1 },
      outerDiameter: { value: 22 },
      innerDiameter: { value: 8 },
      width: { value: 10 },
    },
    mass: { value: 0.033 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title:
          'KHK Gears (US catalogue), SS1-20 carbon steel spur gear (read through a summarising fetch)',
        url: 'https://catalog.khkgears.us/item/spur-gears/spur-gears-ss/ss1-20',
        read: READ,
      },
    ],
    verified: false,
    notes: `Hub 16 mm, total length 20 mm. Pairs with SS1-60 for 3:1. ${KHK_STEEL_NOTE}`,
  },
  {
    id: 'gear/khk-ss1-60',
    version: 1,
    family: 'gear',
    fieldsVersion: 2,
    maker: 'KHK',
    partNumber: 'SS1-60',
    description: 'Carbon steel spur gear, module 1, 60 teeth, 10 mm face, with hub',
    ratings: {
      teeth: { value: 60 },
      pressureAngle: { value: 20 },
      helixAngle: { value: 0 },
      ratedTorque: { value: 24.2, basis: 'allowable torque, bending strength (KHK conditions)' },
      surfaceTorque: { value: 3.4, basis: 'allowable torque, surface durability (KHK conditions)' },
      material: { text: 'S45C (AISI 1045) carbon steel' },
      hardness: { text: 'under 194 HB' },
      quality: { text: 'JIS grade N8 (JIS B1702-1:1998)' },
    },
    dimensions: {
      module: { value: 1 },
      outerDiameter: { value: 62 },
      innerDiameter: { value: 10 },
      width: { value: 10 },
    },
    mass: { value: 0.29 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title:
          'KHK Gears (US catalogue), SS1-60 carbon steel spur gear (read through a summarising fetch)',
        url: 'https://catalog.khkgears.us/item/spur-gears/spur-gears-ss/ss1-60',
        read: READ,
      },
    ],
    verified: false,
    notes: `Hub 35 mm, total length 20 mm. Pairs with SS1-20 for 3:1: the pinion's surface rating, 0.33 N*m, is 0.99 N*m at this gear, below its own 3.4 N*m, so the pinion sets the pair's limit. ${KHK_STEEL_NOTE}`,
  },
];
