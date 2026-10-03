// Framing members as three.js objects (T6.5a: instancing, per-instance pick ids, edges per
// group). Per distinct shape: one geometry, one `InstancedMesh` on screen coloured per instance
// (role colour, or the hover and selection colours), and one in the pick scene with a per-instance
// `pickId` attribute that the app's pick shader reads unchanged (`#include <begin_vertex>` and
// `<project_vertex>` apply `instanceMatrix`). Per framing group: one `LineSegments` of its
// members' edges in world coordinates, the LOD rule hiding it when the stock gets thin on screen.
//
// Updates are incremental: a shape mesh is built once and disposed when regen drops its key; a
// batch whose instance lists are the same objects as before keeps its GPU buffers (only its pick
// ids are rewritten, since slots may move); a group's edges are rebuilt only when its set is new.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  type LineBasicMaterial,
  type Material,
  type Scene,
  type ShaderMaterial,
} from 'three';
import type { MemberMeshData } from '@manufakture/regen';
import {
  EMPTY_MEMBER_VIEW,
  batchBounds,
  layoutMembers,
  memberColor,
  memberEdgesVisible,
  memberPickId,
  memberSlotOf,
  sameBatch,
  type MemberBatch,
  type MemberLayout,
  type MemberSetView,
  type MemberView,
} from './members';

/** Edges of a shape whose faces meet at more than this many degrees. */
const EDGE_ANGLE = 20;

export type MemberHighlight = 'hover' | 'selected';

export interface MemberMaterials {
  shaded: Material;
  pick: ShaderMaterial;
  edges: LineBasicMaterial;
}

export interface MemberColors {
  hover: Color;
  selected: Color;
}

interface ShapeObjects {
  mesh: MemberMeshData;
  geometry: BufferGeometry;
  /** Edge segments in the shape's own frame: xyz xyz per segment. */
  edges: Float32Array;
}

interface BatchObjects {
  batch: MemberBatch;
  shaded: InstancedMesh;
  pick: InstancedMesh;
  pickGeometry: BufferGeometry;
  pickIds: InstancedBufferAttribute;
  /** Per instance: its highlight, to repaint only what changes. */
  state: (MemberHighlight | null)[];
  base: Color[];
}

interface GroupEdges {
  set: MemberSetView;
  lines: LineSegments<BufferGeometry, LineBasicMaterial>;
  /** The thinnest stock in the group, mm: what the LOD rule measures. */
  thinnest: number;
}

export interface MemberObjectStats {
  sets: number;
  members: number;
  shapes: number;
  /** Draw calls of the members on screen: a batch each, plus a group's edges while shown. */
  drawCalls: number;
  triangles: number;
  edgesShown: number;
}

export class MemberObjects {
  private view: MemberView = EMPTY_MEMBER_VIEW;
  private layout: MemberLayout = layoutMembers(EMPTY_MEMBER_VIEW);
  private readonly shapes = new Map<string, ShapeObjects>();
  private batches: BatchObjects[] = [];
  private groups: GroupEdges[] = [];
  private visible = true;
  private edgesOn = true;
  private highlights = new Map<string, MemberHighlight>();
  private readonly scratch = new Color();

  constructor(
    private readonly scene: Scene,
    private readonly pickScene: Scene,
    private readonly materials: MemberMaterials,
    private readonly colors: MemberColors,
  ) {}

  /** Show a view; returns whether anything changed. */
  set(view: MemberView): boolean {
    if (view === this.view) return false;
    const previous = this.view;
    this.view = view;
    if (view.meshes !== previous.meshes) this.syncShapes();
    this.layout = layoutMembers(view);
    this.syncBatches();
    this.syncGroups();
    this.applyVisibility();
    return true;
  }

  /** The members' data and layout, as last set. */
  current(): { view: MemberView; layout: MemberLayout } {
    return { view: this.view, layout: this.layout };
  }

  /** The full id a pick id stands for, or null when it is not a drawn member's. */
  idAtPick(pickId: number): string | null {
    const slot = memberSlotOf(pickId);
    return slot === null ? null : (this.layout.slots[slot] ?? null);
  }

  has(fullId: string): boolean {
    return this.layout.locate.has(fullId);
  }

  /** Colour these members (full id to highlight); every other one in its role colour. */
  setHighlights(highlights: Map<string, MemberHighlight>): void {
    this.highlights = highlights;
    for (const b of this.batches) {
      let changed = false;
      b.batch.ids.forEach((id, i) => {
        const next = highlights.get(id) ?? null;
        if (b.state[i] === next) return;
        b.state[i] = next;
        const color =
          next === 'selected'
            ? this.colors.selected
            : next === 'hover'
              ? this.colors.hover
              : b.base[i]!;
        b.shaded.setColorAt(i, color);
        changed = true;
      });
      if (changed && b.shaded.instanceColor) b.shaded.instanceColor.needsUpdate = true;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Apply Show edges and the LOD rule at this many world units per pixel. */
  updateEdges(showEdges: boolean, worldPerPixel: number): void {
    this.edgesOn = showEdges;
    for (const g of this.groups) {
      g.lines.visible = this.visible && showEdges && memberEdgesVisible(g.thinnest, worldPerPixel);
    }
  }

  /** The on-screen meshes, for raycasts (zoom pivot, hidden depth). */
  raycastTargets(): InstancedMesh[] {
    return this.visible ? this.batches.map((b) => b.shaded) : [];
  }

  /** The world box of every member, or null. */
  bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    let out: { min: [number, number, number]; max: [number, number, number] } | null = null;
    for (const b of this.batches) {
      const shape = this.shapes.get(b.batch.shape);
      const box = shape ? batchBounds(b.batch, shape.mesh) : null;
      if (!box) continue;
      if (!out) {
        out = box;
        continue;
      }
      for (let a = 0; a < 3; a++) {
        out.min[a] = Math.min(out.min[a]!, box.min[a]!);
        out.max[a] = Math.max(out.max[a]!, box.max[a]!);
      }
    }
    return out;
  }

  stats(): MemberObjectStats {
    let triangles = 0;
    for (const b of this.batches) {
      const shape = this.shapes.get(b.batch.shape);
      if (shape) triangles += (shape.mesh.indices.length / 3) * b.batch.ids.length;
    }
    const edgesShown = this.groups.filter((g) => g.lines.visible).length;
    return {
      sets: this.view.sets.length,
      members: this.layout.slots.length,
      shapes: this.batches.length,
      drawCalls: this.visible ? this.batches.length + edgesShown : 0,
      triangles: this.visible ? triangles : 0,
      edgesShown,
    };
  }

  dispose(): void {
    for (const b of this.batches) this.disposeBatch(b);
    for (const g of this.groups) this.disposeGroup(g);
    for (const s of this.shapes.values()) s.geometry.dispose();
    this.batches = [];
    this.groups = [];
    this.shapes.clear();
    this.view = EMPTY_MEMBER_VIEW;
    this.layout = layoutMembers(EMPTY_MEMBER_VIEW);
  }

  // Internals ---------------------------------------------------------------------------------

  private syncShapes(): void {
    for (const [key, shape] of this.shapes) {
      if (this.view.meshes.get(key) === shape.mesh) continue;
      // A batch still on it is rebuilt by syncBatches, which runs next.
      shape.geometry.dispose();
      this.shapes.delete(key);
    }
    for (const [key, mesh] of this.view.meshes) {
      if (this.shapes.has(key)) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new BufferAttribute(mesh.indices, 1));
      const edgeGeometry = new EdgesGeometry(geometry, EDGE_ANGLE);
      const edges = Float32Array.from(edgeGeometry.getAttribute('position').array);
      edgeGeometry.dispose();
      this.shapes.set(key, { mesh, geometry, edges });
    }
  }

  private syncBatches(): void {
    const old = new Map(this.batches.map((b) => [b.batch.shape, b]));
    const next: BatchObjects[] = [];
    for (const batch of this.layout.batches) {
      const shape = this.shapes.get(batch.shape)!;
      const prev = old.get(batch.shape);
      if (prev && sameBatch(prev.batch, batch) && prev.shaded.geometry === shape.geometry) {
        old.delete(batch.shape);
        prev.batch = batch;
        this.writePickIds(prev);
        next.push(prev);
        continue;
      }
      next.push(this.buildBatch(batch, shape));
    }
    for (const b of old.values()) this.disposeBatch(b);
    this.batches = next;
    // New instances start in their role colour: paint the current highlights on them.
    this.setHighlights(this.highlights);
  }

  private buildBatch(batch: MemberBatch, shape: ShapeObjects): BatchObjects {
    const count = batch.ids.length;
    const shaded = new InstancedMesh(shape.geometry, this.materials.shaded, count);
    shaded.instanceMatrix.array.set(batch.matrices);
    shaded.instanceMatrix.needsUpdate = true;
    const base = batch.roles.map((role) => new Color(memberColor(role)));
    base.forEach((c, i) => shaded.setColorAt(i, c));
    shaded.computeBoundingSphere();
    shaded.renderOrder = 3;
    this.scene.add(shaded);

    // Attribute objects of its own over the same arrays: three.js keys GPU buffers by attribute
    // object, so disposing this geometry frees only the pick pass's copies, never the shape's.
    const pickGeometry = new BufferGeometry();
    pickGeometry.setAttribute('position', new BufferAttribute(shape.mesh.positions, 3));
    pickGeometry.setIndex(new BufferAttribute(shape.mesh.indices, 1));
    const pickIds = new InstancedBufferAttribute(new Float32Array(count), 1);
    pickGeometry.setAttribute('pickId', pickIds);
    const pick = new InstancedMesh(pickGeometry, this.materials.pick, count);
    pick.instanceMatrix = shaded.instanceMatrix;
    // The pick window is a few pixels wide: culling against it saves nothing.
    pick.frustumCulled = false;
    this.pickScene.add(pick);

    const out: BatchObjects = {
      batch,
      shaded,
      pick,
      pickGeometry,
      pickIds,
      state: new Array<MemberHighlight | null>(count).fill(null),
      base,
    };
    this.writePickIds(out);
    return out;
  }

  private writePickIds(b: BatchObjects): void {
    const ids = b.pickIds.array as Float32Array;
    for (let i = 0; i < ids.length; i++) ids[i] = memberPickId(b.batch.slotBase + i);
    b.pickIds.needsUpdate = true;
  }

  private disposeBatch(b: BatchObjects): void {
    b.shaded.removeFromParent();
    b.pick.removeFromParent();
    // The shape geometry is the shape's; the pick geometry and its attributes are the batch's.
    b.pickGeometry.dispose();
    b.shaded.dispose();
    b.pick.dispose();
  }

  private syncGroups(): void {
    const old = new Map(this.groups.map((g) => [g.set, g]));
    const next: GroupEdges[] = [];
    for (const set of this.view.sets) {
      const prev = old.get(set);
      if (prev) {
        old.delete(set);
        next.push(prev);
        continue;
      }
      next.push(this.buildGroup(set));
    }
    for (const g of old.values()) this.disposeGroup(g);
    this.groups = next;
  }

  private buildGroup(set: MemberSetView): GroupEdges {
    let total = 0;
    for (const list of set.instances) {
      const shape = this.shapes.get(list.shape);
      if (shape) total += (shape.edges.length / 3) * list.ids.length;
    }
    const positions = new Float32Array(total * 3);
    let o = 0;
    for (const list of set.instances) {
      const shape = this.shapes.get(list.shape);
      if (!shape) continue;
      const e = shape.edges;
      for (let k = 0; k < list.ids.length; k++) {
        const m = list.matrices.subarray(k * 16, k * 16 + 16);
        for (let v = 0; v < e.length; v += 3) {
          const x = e[v]!;
          const y = e[v + 1]!;
          const z = e[v + 2]!;
          positions[o++] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
          positions[o++] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
          positions[o++] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const lines = new LineSegments(geometry, this.materials.edges);
    lines.renderOrder = 4;
    this.scene.add(lines);
    let thinnest = Infinity;
    for (const m of set.members) thinnest = Math.min(thinnest, m.stock.width, m.stock.depth);
    return { set, lines, thinnest: Number.isFinite(thinnest) ? thinnest : 0 };
  }

  private disposeGroup(g: GroupEdges): void {
    g.lines.removeFromParent();
    g.lines.geometry.dispose();
  }

  private applyVisibility(): void {
    for (const b of this.batches) {
      b.shaded.visible = this.visible;
      b.pick.visible = this.visible;
    }
    for (const g of this.groups) g.lines.visible = g.lines.visible && this.visible && this.edgesOn;
  }

  /** For tests: the colour an instance is drawn in now. */
  instanceColor(fullId: string): string | null {
    const at = this.layout.locate.get(fullId);
    const b = at ? this.batches[at.batch] : undefined;
    if (!at || !b) return null;
    b.shaded.getColorAt(at.index, this.scratch);
    return `#${this.scratch.getHexString()}`;
  }
}
