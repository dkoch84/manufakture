// Built-in bearing entries (T9.2d; ADR 0017 decision 7; T9.0c's field list for bearings). Typical
// published values, every one `verified: false`: SKF's own product pages render their tables with
// script and could not be read, so the SKF values come from a catalogue mirror (bearingsize.info),
// which each source title says, and none has been checked against SKF's current catalogue. The
// sizes span what a cable trainer's spool and reduction shafts would use: the 62 series at 15 and
// 20 mm, a thin-section 618 for a large hollow shaft, an angular contact pair candidate and a
// drawn cup needle bearing. T9.2a's samples (`bearing/skf-6001-2rsh`, `bearing/skf-6005-2rsh`)
// stay in `../parts/catalog.ts`. Ratings are SI (N, rad/s), dimensions millimetres, mass
// kilograms. Nothing here says a bearing is fit for a design: the checks state margins.

import type { BuiltinEntry } from '../parts/catalog';

const READ = '2026-10-10';
const kn = (v: number) => v * 1000;
/** r/min to rad/s. */
const rpm = (v: number) => (v * 2 * Math.PI) / 60;

const MIRROR =
  "bearingsize.info catalogue, a mirror of the maker's table (not the maker); read through a summarising fetch";

/** The built-in bearings, every version. */
export const BEARING_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: 'bearing/ina-hk1612',
    version: 1,
    family: 'bearing',
    fieldsVersion: 2,
    maker: 'Schaeffler (INA)',
    partNumber: 'HK1612',
    description: 'Drawn cup needle roller bearing, open ends, 16 x 22 x 12 mm',
    ratings: {
      type: { text: 'needle' },
      dynamicLoad: { value: 7600 },
      staticLoad: { value: 9700 },
      fatigueLimit: { value: 1160 },
      limitingSpeed: { value: rpm(15600) },
      referenceSpeed: { value: rpm(10900) },
      closure: { text: 'open' },
    },
    dimensions: {
      innerDiameter: { value: 16 },
      outerDiameter: { value: 22 },
      width: { value: 12 },
    },
    mass: { value: 0.012 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: `${MIRROR}: Bearing HK1612 (INA)`,
        url: 'https://bearingsize.info/catalogue-online/needle-roller-bearings/bearing-hk1612-ina-obj27527.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'A drawn cup bearing has no inner ring: the bore given is Fw, the diameter of the hardened, ground shaft the needles run on, and the ratings assume that shaft. The cup is pressed into the housing, which sets its roundness. C0 above C is normal for a line-contact bearing. Width tolerance -0.3 mm.',
  },
  {
    id: 'bearing/skf-61805-2rs1',
    version: 1,
    family: 'bearing',
    fieldsVersion: 2,
    maker: 'SKF',
    partNumber: '61805-2RS1',
    description:
      'Thin-section deep groove ball bearing (the "6805" size), 25 x 37 x 7 mm, contact seals both sides',
    ratings: {
      type: { text: 'deep groove ball' },
      dynamicLoad: { value: kn(4.4) },
      staticLoad: { value: kn(2.6) },
      fatigueLimit: { value: kn(0.125) },
      limitingSpeed: { value: rpm(11000) },
      referenceSpeed: { unknown: true },
      closure: { text: 'contact seal' },
      kr: { value: 0.015 },
      f0: { value: 14.2 },
    },
    dimensions: {
      innerDiameter: { value: 25 },
      outerDiameter: { value: 37 },
      width: { value: 7 },
    },
    mass: { value: 0.0215 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: `${MIRROR}: Bearing 61805-2RS1 (SKF)`,
        url: 'https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-61805-2rs1-skf-obj32477.html',
        read: READ,
      },
      {
        title:
          'Web search summary of distributor pages for SKF 61805-2RS1 (C 4.36 kN, C0 2.6 kN, Pu 0.125 kN, 11000 r/min)',
        url: 'https://www.qualitybearingsonline.com/61805-2rs1-SKF-deep-groove-bearings-25x37x7/',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'The mirror rounds C to 4.4 kN; a distributor summary gives 4.36 kN. Thin-section bearings carry little: chosen for a hollow or large shaft, not for load. No reference speed was given for the sealed bearing.',
  },
  {
    id: 'bearing/skf-6202-2rsh',
    version: 1,
    family: 'bearing',
    fieldsVersion: 2,
    maker: 'SKF',
    partNumber: '6202-2RSH',
    description: 'Deep groove ball bearing, 15 x 35 x 11 mm, contact seals both sides',
    ratings: {
      type: { text: 'deep groove ball' },
      dynamicLoad: { value: kn(8.06) },
      staticLoad: { value: kn(3.75) },
      fatigueLimit: { value: kn(0.16) },
      limitingSpeed: { value: rpm(13000) },
      referenceSpeed: { unknown: true },
      closure: { text: 'contact seal' },
      kr: { value: 0.025 },
      f0: { value: 13 },
    },
    dimensions: {
      innerDiameter: { value: 15 },
      outerDiameter: { value: 35 },
      width: { value: 11 },
    },
    mass: { value: 0.046 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: `${MIRROR}: Bearing 6202-2RSH (SKF)`,
        url: 'https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-6202-2rsh-skf-obj208322.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "One search summary gave 43000 and 28000 r/min for this bearing, which are the open 6202's reference and limiting speeds; the sealed bearing's limiting speed is 13000 r/min, set by the seal lip. The mirror gives Pu as 0.16 with no unit; kN is assumed, as for every other SKF row.",
  },
  {
    id: 'bearing/skf-6204-2rsh',
    version: 1,
    family: 'bearing',
    fieldsVersion: 2,
    maker: 'SKF',
    partNumber: '6204-2RSH',
    description: 'Deep groove ball bearing, 20 x 47 x 14 mm, contact seals both sides',
    ratings: {
      type: { text: 'deep groove ball' },
      dynamicLoad: { value: kn(13.5) },
      staticLoad: { value: kn(6.6) },
      fatigueLimit: { value: kn(0.28) },
      limitingSpeed: { value: rpm(10000) },
      referenceSpeed: { unknown: true },
      closure: { text: 'contact seal' },
      kr: { value: 0.025 },
      f0: { value: 13 },
    },
    dimensions: {
      innerDiameter: { value: 20 },
      outerDiameter: { value: 47 },
      width: { value: 14 },
    },
    mass: { value: 0.108 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: `${MIRROR}: Bearing 6204-2RSH (SKF)`,
        url: 'https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-6204-2rsh-skf-obj32447.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      'A likely spool bearing: at 890 N of cable pull shared evenly by two of them (estimated), C / P is about 30. The mirror also gives abutment sizes (da 25.6 to 26 mm, Da at most 41.4 mm, ra at most 1 mm).',
  },
  {
    id: 'bearing/skf-7202-bep',
    version: 1,
    family: 'bearing',
    fieldsVersion: 2,
    maker: 'SKF',
    partNumber: '7202 BEP',
    description:
      'Single row angular contact ball bearing, 40 degree contact angle, polyamide cage, 15 x 35 x 11 mm',
    ratings: {
      type: { text: 'angular contact' },
      dynamicLoad: { value: kn(8.3) },
      staticLoad: { value: kn(4.4) },
      fatigueLimit: { value: kn(0.183) },
      limitingSpeed: { value: rpm(24000) },
      referenceSpeed: { value: rpm(24000) },
      closure: { text: 'open' },
      kr: { value: 0.095 },
      contactAngle: { value: 40, estimated: true },
    },
    dimensions: {
      innerDiameter: { value: 15 },
      outerDiameter: { value: 35 },
      width: { value: 11 },
    },
    mass: { value: 0.045 },
    geometry: { kind: 'placeholder', shape: { kind: 'ring' } },
    sources: [
      {
        title: `${MIRROR}: Bearing 7202 BEP (SKF)`,
        url: 'https://bearingsize.info/catalogue-online/angular-contact-ball-bearings/bearing-7202-bep-skf-obj34075.html',
        read: READ,
      },
    ],
    verified: false,
    notes:
      "Carries axial load in one direction only, so it is mounted as a pair, back to back or face to face. The contact angle is not on the page: 40 degrees is what the B in the designation means in SKF's scheme (estimated); E is the internal design and P the polyamide cage. The mirror also gives ka 1.4, e 1.14, pressure centre a = 16 mm and the X, Y factors (X 0.57 or 0.35; Y0 0.52 or 0.26; Y1 0.55; Y2 0.93 or 0.57) for single and paired bearings. It gives the same 24000 r/min as reference and limiting speed.",
  },
];
