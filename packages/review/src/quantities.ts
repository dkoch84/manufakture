// Quantity deltas (ADR 0016 decision 11): the cut list, its hardware and each construction
// takeoff at base and at head, row by row (rows are matched by their takeoff key, which names
// the same thing on both sides) and total by total. Only what differs is listed.

import type { Quantities as SessionQuantities } from '@manufakture/session';
import { bounded, round, shown } from './text';
import { LIMITS, type Quantities, type QuantityDelta, type QuantityTotalDelta } from './types';

interface Row {
  key: string;
  item: string;
  category: string;
  unit: string;
  quantity: number;
  extended: number;
}

interface Total {
  group: string;
  unit: string;
  value: number;
}

interface List {
  name: string;
  rows: readonly Row[];
  totals: readonly Total[];
}

function lists(q: SessionQuantities, partName: (id: string) => string): List[] {
  const out: List[] = [];
  if (q.cutList) {
    out.push({ name: 'cut list', rows: q.cutList.rows, totals: q.cutList.totals });
    out.push({ name: 'hardware', rows: q.cutList.hardware, totals: [] });
  }
  for (const t of q.takeoffs) {
    out.push({
      name: `takeoff ${partName(t.partId)}`,
      rows: t.takeoff.rows,
      totals: t.takeoff.totals,
    });
  }
  return out;
}

const amounts = (r: Row | undefined) =>
  r === undefined ? null : { quantity: round(r.quantity), extended: round(r.extended) };

export function quantityDeltas(
  base: SessionQuantities,
  head: SessionQuantities,
  partName: (id: string) => string,
): Quantities {
  const a = new Map(lists(base, partName).map((l) => [l.name, l]));
  const b = new Map(lists(head, partName).map((l) => [l.name, l]));
  const rows: QuantityDelta[] = [];
  const totals: QuantityTotalDelta[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])]) {
    const x = a.get(name);
    const y = b.get(name);
    const was = new Map((x?.rows ?? []).map((r) => [`${r.key}\u0000${r.unit}`, r]));
    const now = new Map((y?.rows ?? []).map((r) => [`${r.key}\u0000${r.unit}`, r]));
    for (const k of [...new Set([...now.keys(), ...was.keys()])]) {
      const r0 = was.get(k);
      const r1 = now.get(k);
      const before = amounts(r0);
      const after = amounts(r1);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const r = (r1 ?? r0)!;
      rows.push({
        list: shown(name),
        key: shown(r.key),
        item: shown(r.item),
        category: shown(r.category, 64),
        unit: shown(r.unit, 32),
        base: before,
        head: after,
      });
    }
    const tWas = new Map((x?.totals ?? []).map((t) => [`${t.group}\u0000${t.unit}`, t]));
    const tNow = new Map((y?.totals ?? []).map((t) => [`${t.group}\u0000${t.unit}`, t]));
    for (const k of [...new Set([...tNow.keys(), ...tWas.keys()])]) {
      const t0 = tWas.get(k);
      const t1 = tNow.get(k);
      const v0 = t0 === undefined ? null : round(t0.value);
      const v1 = t1 === undefined ? null : round(t1.value);
      if (v0 === v1) continue;
      const t = (t1 ?? t0)!;
      totals.push({
        list: shown(name),
        group: shown(t.group, 64),
        unit: shown(t.unit, 32),
        base: v0,
        head: v1,
      });
    }
  }
  const notes = [...new Set([...base.notes, ...head.notes])].map((n) => shown(n));
  return {
    rows: bounded(rows, LIMITS.quantities),
    totals: totals.slice(0, LIMITS.quantities),
    notes: notes.slice(0, LIMITS.errors),
  };
}
