// Reading an IFC file back for the tests, with the web-ifc that `@manufakture/io` loads (this
// package does not depend on web-ifc itself).

import { loadWebIfc } from '@manufakture/io';
import { memberCorners, type Member } from '../members';

type Loaded = Awaited<ReturnType<typeof loadWebIfc>>;

export interface IfcReader {
  read(bytes: Uint8Array): number;
  ids(model: number, type: number): number[];
  // web-ifc's lines are untyped objects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lines(model: number, type: number): any[];
  counts(model: number): Record<keyof ReturnType<typeof types>, number>;
  /** Every rooted entity's GlobalId, by type and express id (files are written in order). */
  globalIds(model: number): Map<string, string>;
  /** A product's mesh bounding box as web-ifc reads it back, mm, Z up: [min, max]. */
  boxOf(model: number, id: number): [number[], number[]];
  /** The largest distance, mm, between each member's mesh box and its blank's. */
  worstPlacement(model: number, members: readonly Member[]): number;
  close(): void;
  mod: Loaded['mod'];
  api: Loaded['api'];
}

const types = (mod: Loaded['mod']) => ({
  wall: mod.IFCWALL,
  opening: mod.IFCOPENINGELEMENT,
  door: mod.IFCDOOR,
  window: mod.IFCWINDOW,
  member: mod.IFCMEMBER,
  beam: mod.IFCBEAM,
  plate: mod.IFCPLATE,
  covering: mod.IFCCOVERING,
  slab: mod.IFCSLAB,
  roof: mod.IFCROOF,
  storey: mod.IFCBUILDINGSTOREY,
  building: mod.IFCBUILDING,
  site: mod.IFCSITE,
  project: mod.IFCPROJECT,
});

export const fullId = (x: { owner: string; id: string }) => `${x.owner}:${x.id}`;

export async function ifcReader(): Promise<IfcReader> {
  const { mod, api } = await loadWebIfc();
  const open: number[] = [];
  const ids = (m: number, type: number): number[] => {
    const v = api.GetLineIDsWithType(m, type);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  };
  const boxOf = (m: number, id: number): [number[], number[]] => {
    const mesh = api.GetFlatMesh(m, id);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let g = 0; g < mesh.geometries.size(); g++) {
      const pg = mesh.geometries.get(g);
      const t = pg.flatTransformation;
      const geo = api.GetGeometry(m, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      for (let i = 0; i < v.length; i += 6) {
        const [x, y, z] = [v[i]!, v[i + 1]!, v[i + 2]!];
        const w = [0, 1, 2].map((r) => t[r]! * x + t[4 + r]! * y + t[8 + r]! * z + t[12 + r]!);
        // Metres, Y up, back to millimetres, Z up.
        const p = [w[0]! * 1000, -w[2]! * 1000, w[1]! * 1000];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, p[k]!);
          hi[k] = Math.max(hi[k]!, p[k]!);
        }
      }
      geo.delete();
    }
    return [lo, hi];
  };
  return {
    mod,
    api,
    read(bytes) {
      const m = api.OpenModel(bytes);
      open.push(m);
      return m;
    },
    ids,
    lines: (m, type) => ids(m, type).map((id) => api.GetLine(m, id)),
    counts: (m) =>
      Object.fromEntries(
        Object.entries(types(mod)).map(([k, t]) => [k, ids(m, t).length]),
      ) as Record<keyof ReturnType<typeof types>, number>,
    globalIds(m) {
      const out = new Map<string, string>();
      const all = api.GetAllLines(m);
      for (let i = 0; i < all.size(); i++) {
        const id = all.get(i);
        const line = api.GetLine(m, id);
        if (line?.GlobalId === undefined) continue;
        out.set(`${api.GetNameFromTypeCode(line.type)}#${id}`, line.GlobalId.value);
      }
      return out;
    },
    boxOf,
    worstPlacement(m, members) {
      const byTag = new Map(
        [...ids(m, mod.IFCMEMBER), ...ids(m, mod.IFCBEAM)].map((id) => [
          api.GetLine(m, id).Tag.value as string,
          id,
        ]),
      );
      let worst = 0;
      for (const member of members) {
        const [lo, hi] = boxOf(m, byTag.get(fullId(member))!);
        const c = memberCorners(member);
        for (let k = 0; k < 3; k++) {
          const want = [Math.min(...c.map((p) => p[k]!)), Math.max(...c.map((p) => p[k]!))];
          worst = Math.max(worst, Math.abs(lo[k]! - want[0]!), Math.abs(hi[k]! - want[1]!));
        }
      }
      return worst;
    },
    close() {
      for (const m of open) api.CloseModel(m);
      open.length = 0;
    },
  };
}
