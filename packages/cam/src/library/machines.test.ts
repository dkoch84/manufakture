import { describe, expect, it } from 'vitest';
import {
  COMPACT_ROUTER_DIAL,
  DEFAULT_MACHINE_ID,
  MACHINES,
  SPINDLES,
  defaultPost,
  findMachine,
  machineDial,
  unverifiedMachineFields,
  validateMachine,
  type MachineProfile,
} from './index';

const IN = 25.4;

function machine(id: string): MachineProfile {
  const m = findMachine(id);
  if (!m) throw new Error(`no machine ${id}`);
  return m;
}

describe('machine profiles', () => {
  it('every machine validates', () => {
    for (const m of MACHINES) {
      const r = validateMachine(m);
      expect(r.ok, r.ok ? m.id : r.error.message).toBe(true);
    }
  });

  it('ids are unique; the primary machines come first; the default is the Shapeoko 5 Pro 4x4', () => {
    expect(new Set(MACHINES.map((m) => m.id)).size).toBe(MACHINES.length);
    expect(MACHINES.filter((m) => m.primary).map((m) => m.id)).toEqual([
      'shapeoko-5-pro-4x4',
      'shapeoko-4-xxl',
    ]);
    expect(MACHINES.slice(0, 2).every((m) => m.primary)).toBe(true);
    expect(DEFAULT_MACHINE_ID).toBe('shapeoko-5-pro-4x4');
    expect(machine(DEFAULT_MACHINE_ID).primary).toBe(true);
  });

  it('ships every Shapeoko 4 and 5 Pro size', () => {
    expect(MACHINES.map((m) => m.id).sort()).toEqual([
      'shapeoko-4',
      'shapeoko-4-xl',
      'shapeoko-4-xxl',
      'shapeoko-5-pro-2x2',
      'shapeoko-5-pro-4x2',
      'shapeoko-5-pro-4x4',
    ]);
  });

  it("travel is the maker's figure, in mm", () => {
    const travel = (id: string) => {
      const t = machine(id).travel;
      return [t.x.value, t.y.value, t.z.value];
    };
    expect(travel('shapeoko-5-pro-4x4')).toEqual([1237, 1237, 155]);
    expect(travel('shapeoko-5-pro-4x2')).toEqual([1237, 623, 155]);
    expect(travel('shapeoko-5-pro-2x2')).toEqual([623, 623, 155]);
    expect(travel('shapeoko-4-xxl')).toEqual([33 * IN, 33 * IN, 4 * IN]);
    expect(travel('shapeoko-4-xl')).toEqual([33 * IN, 17.5 * IN, 4 * IN]);
    expect(travel('shapeoko-4')).toEqual([17.5 * IN, 17.5 * IN, 4 * IN]);
  });

  it('default configuration: Compact Router with its dial, Carbide Motion, BitSetter, Grbl 1.1', () => {
    for (const m of MACHINES) {
      expect(m.spindle.value).toBe('carbide-compact-router');
      expect(machineDial(m)).toBe(COMPACT_ROUTER_DIAL);
      expect(m.sender.value).toBe('carbide-motion');
      expect(m.toolLengthSensor.value).toBe(true);
      expect(m.toolLengthSensor.verified).toBe(true);
      expect(m.firmware.value).toBe('grbl-1.1');
      expect(defaultPost(m)).toBe('carbide-motion');
      expect(defaultPost(m, ['grbl'])).toBe('grbl');
      expect(defaultPost(m, new Set(['grbl', 'carbide-motion']))).toBe('carbide-motion');
      expect(defaultPost(m, ['grblhal'])).toBeUndefined();
      expect(m.posts).toContain('grbl');
      expect(m.maxFeed.value).toBe(5000);
      expect(m.maxFeed.verified).toBe(true);
    }
  });

  it("the dial table is the Compact Router product page's", () => {
    expect(COMPACT_ROUTER_DIAL.map((d) => [d.setting, d.rpm])).toEqual([
      ['1', 11000],
      ['2', 13500],
      ['3', 18250],
      ['4', 24500],
      ['5', 29250],
      ['6', 31000],
    ]);
    const router = SPINDLES.find((s) => s.id === 'carbide-compact-router')!;
    expect(router.kind).toBe('router');
    expect(router.dial?.verified).toBe(true);
    const vfd = SPINDLES.find((s) => s.kind === 'vfd')!;
    expect(vfd.dial).toBeUndefined();
    expect(vfd.rpmRange.value).toEqual([8000, 24000]);
  });

  it('flags the numbers no maker page states', () => {
    const fields = unverifiedMachineFields(machine('shapeoko-5-pro-4x4'));
    expect(fields).toEqual(['maxRapid', 'firmware']);
    expect(unverifiedMachineFields(machine('shapeoko-4-xxl'))).toEqual(['maxRapid', 'firmware']);
    for (const m of MACHINES) {
      expect(m.maxRapid.note).toBeTruthy();
      expect(m.firmware.note).toBeTruthy();
    }
  });

  it('refuses a broken profile', () => {
    const m = machine('shapeoko-4');
    const bad = (patch: Partial<MachineProfile>) => validateMachine({ ...m, ...patch });
    expect(bad({ id: 'Shapeoko 4' }).ok).toBe(false);
    expect(bad({ posts: [] }).ok).toBe(false);
    expect(bad({ maxFeed: { ...m.maxFeed, value: -1 } }).ok).toBe(false);
    expect(bad({ maxRapid: { ...m.maxRapid, source: '' } }).ok).toBe(false);
    expect(bad({ spindle: { ...m.spindle, value: 'no-such-spindle' } }).ok).toBe(false);
    expect(bad({ spindleOptions: ['carbide-vfd-65mm', 'carbide-compact-router'] }).ok).toBe(false);
    const r = bad({ travel: { ...m.travel, z: { ...m.travel.z, value: Number.NaN } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('travel.z');
  });
});
