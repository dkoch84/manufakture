// Machine profiles and spindles (T5.1d): the Shapeoko 4 and Shapeoko 5 Pro in every size, in their
// default configuration (the Carbide Compact Router, Carbide Motion, the BitSetter). Every number
// cites the maker's page it was read from on 2026-10-02 and says whether it was checked; numbers no
// maker page states are kept with `verified: false` and a note.
//
// Sources (read 2026-10-02):
// - Carbide Compact Router, https://shop.carbide3d.com/products/carbide-compact-router:
//   "RPM Range 12,000 - 30,000" and "RPM Settings: Dial Value / Approximate RPM: 1 11,000,
//   2 13,500, 3 18,250, 4 24,500, 5 29,250, 6 31,000". The dial's ends lie outside the stated
//   range; both are kept as printed. Carbide 3D's older feeds charts print their own dial table
//   (1 10K ... 6 30K), which differs from the product page's; this one is the product page's.
// - 65mm VFD Spindle Kit, https://shop.carbide3d.com/products/vfd-spindle-kit: "8k - 24k RPM",
//   "RPM is fully controlled by your G-code".
// - Shapeoko 4, https://shop.carbide3d.com/products/shapeoko4: "Cutting Area" Standard
//   17.5"(X) x 17.5"(Y) x 4"(Z), XL 33"(X) x 17.5"(Y) x 4"(Z), XXL 33"(X) x 33"(Y) x 4"(Z);
//   includes "Shapeoko 4 BitSetter" and "Carbide Motion control software"; "Photos include the
//   Carbide Compact Router, which is not included", "We recommend our Carbide Compact Router".
// - Shapeoko 5 Pro, https://carbide3d.com/shapeoko/shapeoko5pro-specs/ (now titled 5.1 Pro; the
//   Shapeoko 5 Pro page archived 2023-09-28 at https://web.archive.org/web/20230928070225/
//   https://carbide3d.com/shapeoko/shapeoko5pro-specs/ gives the same figures, and the 5.1
//   upgrade kit at https://shop.carbide3d.com/products/shapeoko-5-1-pro-upgrade is base frame
//   tubes only): "Machine Travel" 4x4 1237 mm (X) x 1237 mm (Y), 4x2 1237 x 623 mm, 2x2
//   623 x 623 mm (the page computes them as 1249-12 and 635-12); "Total Z Travel" 155 mm (165 - 10;
//   140 mm with Sweepy Pro); includes "Shapeoko 5 Pro BitSetter" and "Carbide Motion control
//   software"; the router or spindle is bought separately ("either our Carbide Compact Router or
//   VFD Spindle").
// - Feed limit, https://carbide3d.com/shapeoko/capable/ (the whole Shapeoko line): "Shapeoko cuts
//   at up to 5000 mm/min, or about 200 inches per minute."

import type { DialSetting } from '../post/writer';
import type { MachineProfile, Sourced, SpindleProfile } from './types';

const IN = 25.4;

const ROUTER_URL = 'https://shop.carbide3d.com/products/carbide-compact-router';
const VFD_URL = 'https://shop.carbide3d.com/products/vfd-spindle-kit';
const SO4_URL = 'https://shop.carbide3d.com/products/shapeoko4';
const SO5_URL = 'https://carbide3d.com/shapeoko/shapeoko5pro-specs/';
const SO5_ARCHIVE =
  'https://web.archive.org/web/20230928070225/https://carbide3d.com/shapeoko/shapeoko5pro-specs/';
const CAPABLE_URL = 'https://carbide3d.com/shapeoko/capable/';
const SO5_FIRMWARE_THREAD = 'https://community.carbide3d.com/t/current-firmware-shapeoko-5/89988';

/**
 * The Carbide Compact Router's speed dial, the default spindle of every Shapeoko profile here:
 * the authoritative copy (the GRBL post's tests use it too).
 */
export const COMPACT_ROUTER_DIAL: readonly DialSetting[] = [
  { setting: '1', rpm: 11000 },
  { setting: '2', rpm: 13500 },
  { setting: '3', rpm: 18250 },
  { setting: '4', rpm: 24500 },
  { setting: '5', rpm: 29250 },
  { setting: '6', rpm: 31000 },
];

/** The spindles the profiles name, by id. */
export const SPINDLES: readonly SpindleProfile[] = [
  {
    id: 'carbide-compact-router',
    name: 'Carbide Compact Router',
    kind: 'router',
    rpmRange: {
      value: [12000, 30000],
      source: `${ROUTER_URL}: "RPM Range 12,000 - 30,000"`,
      verified: true,
      note: 'The dial table runs from 11,000 to 31,000 rpm; the maker prints both.',
    },
    dial: {
      value: COMPACT_ROUTER_DIAL,
      source: `${ROUTER_URL}: "Dial Value / Approximate RPM: 1 11,000, 2 13,500, 3 18,250, 4 24,500, 5 29,250, 6 31,000"`,
      verified: true,
      note: 'Approximate speeds; other routers (a Makita RT0701C) have their own dial.',
    },
    url: ROUTER_URL,
  },
  {
    id: 'carbide-vfd-65mm',
    name: 'Carbide 3D 65mm VFD Spindle',
    kind: 'vfd',
    rpmRange: { value: [8000, 24000], source: `${VFD_URL}: "8k - 24k RPM"`, verified: true },
    url: VFD_URL,
  },
];

const SPINDLE_OPTIONS = ['carbide-compact-router', 'carbide-vfd-65mm'] as const;

/** The posts every profile here suits: Carbide Motion first (the sender shipped), then plain Grbl. */
const SHAPEOKO_POSTS = ['carbide-motion', 'grbl'] as const;

const MAX_FEED: Sourced<number> = {
  value: 5000,
  source: `${CAPABLE_URL}: "Shapeoko cuts at up to 5000 mm/min, or about 200 inches per minute."`,
  verified: true,
};

const MAX_RAPID: Sourced<number> = {
  value: 5000,
  source: `${CAPABLE_URL}: "Shapeoko cuts at up to 5000 mm/min"`,
  verified: false,
  note: 'The maker states no rapid rate; Grbl rapids at its maximum rate settings ($110, $111), taken here as the stated cutting maximum.',
};

const SENDER = (url: string, quote: string): Sourced<string> => ({
  value: 'carbide-motion',
  source: `${url}: "${quote}"`,
  verified: true,
});

function shapeoko4(
  id: string,
  size: string,
  [x, y]: readonly [number, number],
  primary: boolean,
): MachineProfile {
  const area = `${size} "Cutting Area ${x}"(X) x ${y}"(Y) x 4"(Z)"`;
  return {
    id,
    name: `Shapeoko 4${size === 'Standard' ? '' : ` ${size}`}`,
    maker: 'Carbide 3D',
    primary,
    url: SO4_URL,
    travel: {
      x: { value: x * IN, source: `${SO4_URL}: ${area}`, verified: true },
      y: { value: y * IN, source: `${SO4_URL}: ${area}`, verified: true },
      z: { value: 4 * IN, source: `${SO4_URL}: ${area}`, verified: true },
    },
    maxFeed: MAX_FEED,
    maxRapid: MAX_RAPID,
    spindle: {
      value: 'carbide-compact-router',
      source: `${SO4_URL}: "We recommend our Carbide Compact Router"`,
      verified: true,
      note: 'Bought separately ("not included with the Shapeoko 4"); any 65 mm router fits.',
    },
    spindleOptions: SPINDLE_OPTIONS,
    firmware: {
      value: 'grbl-1.1',
      source: `${SO4_URL}: "New Electronics ... our new V3 electronics"`,
      verified: false,
      note: 'No maker page states the firmware; Grbl 1.1 is what the Carbide Motion boards run.',
    },
    sender: SENDER(SO4_URL, 'Shapeoko 4 Includes: ... Carbide Motion control software'),
    toolLengthSensor: {
      value: true,
      source: `${SO4_URL}: "Shapeoko 4 Includes: ... Shapeoko 4 BitSetter"`,
      verified: true,
    },
    posts: SHAPEOKO_POSTS,
  };
}

function shapeoko5Pro(
  id: string,
  size: string,
  [x, y]: readonly [number, number],
  [xFormula, yFormula]: readonly [string, string],
  primary: boolean,
): MachineProfile {
  const travel = `Size ${size} "Machine Travel" ${xFormula} mm (X) x ${yFormula} mm (Y); same on the 2023 Shapeoko 5 Pro page, ${SO5_ARCHIVE}`;
  return {
    id,
    name: `Shapeoko 5 Pro ${size}`,
    maker: 'Carbide 3D',
    primary,
    url: SO5_URL,
    travel: {
      x: { value: x, source: `${SO5_URL}: ${travel}`, verified: true },
      y: { value: y, source: `${SO5_URL}: ${travel}`, verified: true },
      z: {
        value: 155,
        source: `${SO5_URL}: "Total Z Travel" 165 - 10 mm`,
        verified: true,
        note: '140 mm with the Sweepy Pro dust boot.',
      },
    },
    maxFeed: MAX_FEED,
    maxRapid: MAX_RAPID,
    spindle: {
      value: 'carbide-compact-router',
      source: `${SO5_URL}: "65mm trim router or spindle, either our Carbide Compact Router or VFD Spindle"`,
      verified: true,
      note: 'Bought separately; the Compact Router is the default configuration assumed here.',
    },
    spindleOptions: SPINDLE_OPTIONS,
    firmware: {
      value: 'grbl-1.1',
      source: `${SO5_FIRMWARE_THREAD}: asked "Is the Grbl 1.1h from 2019 the most current?", Carbide 3D staff answered "Yes"; https://carbide3d.com/blog/introducing-shapeoko-5-pro/: "new electronics, new motors, new GRBL"`,
      verified: false,
      note: 'Not grblHAL as far as the maker says: its staff name Grbl 1.1h as the current firmware. No specification page states it.',
    },
    sender: SENDER(
      SO5_URL,
      "What's included with Shapeoko 5 Pro: ... Carbide Motion control software",
    ),
    toolLengthSensor: {
      value: true,
      source: `${SO5_URL}: "What's included with Shapeoko 5 Pro: ... Shapeoko 5 Pro BitSetter"`,
      verified: true,
    },
    posts: SHAPEOKO_POSTS,
  };
}

/**
 * Every machine profile, the primary ones (the machines cut on) first: the Shapeoko 5 Pro 4x4 and
 * the Shapeoko 4 XXL, then the other sizes.
 */
export const MACHINES: readonly MachineProfile[] = [
  shapeoko5Pro('shapeoko-5-pro-4x4', '4x4', [1237, 1237], ['1249-12', '1249-12'], true),
  shapeoko4('shapeoko-4-xxl', 'XXL', [33, 33], true),
  shapeoko5Pro('shapeoko-5-pro-4x2', '4x2', [1237, 623], ['1249-12', '635-12'], false),
  shapeoko5Pro('shapeoko-5-pro-2x2', '2x2', [623, 623], ['635-12', '635-12'], false),
  shapeoko4('shapeoko-4-xl', 'XL', [33, 17.5], false),
  shapeoko4('shapeoko-4', 'Standard', [17.5, 17.5], false),
];

/** The machine a new setup uses unless the user picks another. */
export const DEFAULT_MACHINE_ID = 'shapeoko-5-pro-4x4';

export function findMachine(id: string): MachineProfile | undefined {
  return MACHINES.find((m) => m.id === id);
}

export function findSpindle(id: string): SpindleProfile | undefined {
  return SPINDLES.find((s) => s.id === id);
}

/**
 * The post a new setup on this machine uses: its first suitable post, or with `available` (the
 * post ids this build has) the first suitable one that is available; undefined when none is.
 */
export function defaultPost(machine: MachineProfile): string;
export function defaultPost(
  machine: MachineProfile,
  available: Iterable<string>,
): string | undefined;
export function defaultPost(
  machine: MachineProfile,
  available?: Iterable<string>,
): string | undefined {
  if (available === undefined) return machine.posts[0];
  const have = new Set(available);
  return machine.posts.find((p) => have.has(p));
}

/** The dial table of the machine's default spindle, for the post's dial comments; none for a VFD. */
export function machineDial(machine: MachineProfile): readonly DialSetting[] | undefined {
  return findSpindle(machine.spindle.value)?.dial?.value;
}

/**
 * Paths of the numbers and facts in a machine profile (and its default spindle) that were not
 * checked against their source, for the UI to flag: `maxRapid`, `firmware`, `spindle.dial`.
 */
export function unverifiedMachineFields(machine: MachineProfile): string[] {
  const out: string[] = [];
  const check = (path: string, s: Sourced<unknown>) => {
    if (!s.verified) out.push(path);
  };
  check('travel.x', machine.travel.x);
  check('travel.y', machine.travel.y);
  check('travel.z', machine.travel.z);
  check('maxFeed', machine.maxFeed);
  check('maxRapid', machine.maxRapid);
  check('spindle', machine.spindle);
  check('firmware', machine.firmware);
  check('sender', machine.sender);
  check('toolLengthSensor', machine.toolLengthSensor);
  const spindle = findSpindle(machine.spindle.value);
  if (spindle) {
    check('spindle.rpmRange', spindle.rpmRange);
    if (spindle.dial) check('spindle.dial', spindle.dial);
  }
  return out;
}
