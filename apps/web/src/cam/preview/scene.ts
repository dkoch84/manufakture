// The preview's three.js objects (M5 plan, T5.3b): one group placed on the part by the WCS frame
// (its local coordinates are machine coordinates), holding
//
// - the toolpath: one `LineSegments` per operation and move class (`geometry.ts`), cuts in the
//   operation's colour, plunges and ramps in colours of their own, rapids dashed;
// - the stock, a translucent box with its edges;
// - the WCS gizmo: X, Y and Z axes from the WCS origin, drawn over everything;
// - the tool marker, at the tool tip's position for the playback, shaped by the tool's kind.
//
// The playback only changes draw ranges and the marker's position, so scrubbing a large job is
// cheap. The overlay owns its geometries and materials: `dispose` frees them.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three';
import type { Box3, Tool, WcsFrame } from '@manufakture/cam';
import { segmentsBefore, toolPositionAt, type MoveClass, type PreviewPath } from './geometry';

/** Colours of operations' cuts, by their place in the setup (cycled). */
export const OPERATION_COLORS: readonly string[] = [
  '#1f6fd1',
  '#2a9d55',
  '#8e44ad',
  '#0f9fb4',
  '#b5179e',
  '#6d8a12',
  '#3d4fc4',
  '#9c6b30',
];

/** Colours of the other move classes, and of the job's own (link) feed moves. */
export const MOVE_COLORS: Readonly<Record<Exclude<MoveClass, 'cut'>, string> & { link: string }> = {
  plunge: '#d62828',
  ramp: '#f08c00',
  rapid: '#5c6b7a',
  link: '#8a96a3',
};

export const STOCK_COLOR = '#c8a46e';
export const TOOL_COLOR = '#f2b134';

/** The colour of an operation's cuts, from its index in the setup's operation list. */
export function operationColor(index: number): string {
  return OPERATION_COLORS[
    ((index % OPERATION_COLORS.length) + OPERATION_COLORS.length) % OPERATION_COLORS.length
  ]!;
}

/** Machine-to-model placement: the frame's axes as columns, its origin as the translation. */
export function frameMatrix(frame: WcsFrame): Matrix4 {
  return new Matrix4()
    .makeBasis(
      new Vector3(...frame.xAxis),
      new Vector3(...frame.yAxis),
      new Vector3(...frame.zAxis),
    )
    .setPosition(...frame.origin);
}

export interface PreviewSceneInput {
  readonly frame: WcsFrame;
  /** The stock box in machine coordinates. */
  readonly stock: Box3;
  /** The program to draw and play; null: stock and WCS only. */
  readonly path: PreviewPath | null;
  /** Cut colour per operation id; ids not in it (links) are grey. */
  readonly colors: ReadonlyMap<string, string>;
  /** Tools by id, for the marker's shape. */
  readonly tools: ReadonlyMap<string, Tool>;
}

interface DrawnBuffer {
  readonly op: string;
  readonly lines: LineSegments;
  readonly index: number;
}

export class PreviewOverlay {
  readonly root = new Group();
  private readonly drawn: DrawnBuffer[] = [];
  private readonly materials: Material[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly toolMarkers = new Map<string, Group>();
  private hidden: ReadonlySet<string> = new Set();
  private done = 0;
  private readonly path: PreviewPath | null;
  private stockFill: Mesh | null = null;

  constructor(private readonly input: PreviewSceneInput) {
    this.root.name = 'cam-preview';
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(frameMatrix(input.frame));
    this.root.matrixWorldNeedsUpdate = true;
    this.path = input.path;
    this.addStock(input.stock);
    this.addGizmo(input.stock);
    if (input.path) {
      input.path.buffers.forEach((b, index) => {
        const g = this.geometry();
        g.setAttribute('position', new BufferAttribute(b.positions, 3));
        let material: Material;
        if (b.moveClass === 'rapid') {
          g.setAttribute('lineDistance', new BufferAttribute(b.lineDistances!, 1));
          material = this.material(
            new LineDashedMaterial({ color: MOVE_COLORS.rapid, dashSize: 1.5, gapSize: 1.2 }),
          );
        } else {
          const color =
            b.moveClass === 'cut'
              ? (input.colors.get(b.op) ?? MOVE_COLORS.link)
              : MOVE_COLORS[b.moveClass];
          material = this.material(new LineBasicMaterial({ color }));
        }
        const lines = new LineSegments(g, material);
        lines.name = `cam-preview-${b.op}-${b.moveClass}`;
        lines.frustumCulled = false;
        lines.renderOrder = 3;
        this.root.add(lines);
        this.drawn.push({ op: b.op, lines, index });
      });
      this.done = input.path.moveCount;
    }
    this.update();
  }

  /** The number of line buffers drawn (one per operation and move class). */
  get bufferCount(): number {
    return this.drawn.length;
  }

  /** Where the tool marker shown is, in world (model) coordinates; null when none is shown. */
  toolMarkerPosition(): [number, number, number] | null {
    const marker = [...this.toolMarkers.values()].find((m) => m.visible);
    if (!marker) return null;
    this.root.updateMatrixWorld(true);
    return marker.getWorldPosition(new Vector3()).toArray();
  }

  /** Hide the moves of these operation ids (`link` for the job's own). */
  setHidden(ops: ReadonlySet<string>): void {
    this.hidden = ops;
    this.update();
  }

  /** Show or hide the translucent stock box (its edges stay): hidden under the simulated stock. */
  setStockVisible(visible: boolean): void {
    if (this.stockFill) this.stockFill.visible = visible;
  }

  /** Draw the first `done` moves and put the tool where the last of them ends. */
  setProgress(done: number): void {
    this.done = done;
    this.update();
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private update(): void {
    const path = this.path;
    for (const d of this.drawn) {
      const buffer = path!.buffers[d.index]!;
      d.lines.visible = !this.hidden.has(d.op);
      d.lines.geometry.setDrawRange(0, 2 * segmentsBefore(buffer, this.done));
    }
    for (const m of this.toolMarkers.values()) m.visible = false;
    if (!path || path.moveCount === 0) return;
    const k = Math.min(Math.max(Math.round(this.done), 0), path.moveCount);
    // The tool loaded for the last move run (or for the first move, at the start).
    const toolIndex = path.toolOf[Math.max(k - 1, 0)]!;
    const toolId = toolIndex >= 0 ? path.tools[toolIndex]! : null;
    const tool = toolId === null ? undefined : this.input.tools.get(toolId);
    const marker = this.marker(tool);
    marker.position.set(...toolPositionAt(path, k));
    marker.visible = true;
  }

  private geometry(g: BufferGeometry = new BufferGeometry()): BufferGeometry {
    this.geometries.push(g);
    return g;
  }

  private material<M extends Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  private addStock(stock: Box3): void {
    const size = [0, 1, 2].map((i) => Math.max(stock.max[i]! - stock.min[i]!, 1e-3)) as [
      number,
      number,
      number,
    ];
    const box = this.geometry(new BoxGeometry(...size));
    const center = [0, 1, 2].map((i) => (stock.min[i]! + stock.max[i]!) / 2) as [
      number,
      number,
      number,
    ];
    const fill = new Mesh(
      box,
      this.material(
        new MeshBasicMaterial({
          color: STOCK_COLOR,
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
        }),
      ),
    );
    fill.name = 'cam-preview-stock';
    fill.position.set(...center);
    fill.renderOrder = 11;
    this.stockFill = fill;
    const edges = new LineSegments(
      this.geometry(new EdgesGeometry(box)),
      this.material(new LineBasicMaterial({ color: new Color(STOCK_COLOR).multiplyScalar(0.7) })),
    );
    edges.position.set(...center);
    this.root.add(fill, edges);
  }

  private addGizmo(stock: Box3): void {
    const span = Math.max(...[0, 1, 2].map((i) => stock.max[i]! - stock.min[i]!));
    const length = Math.max(5, Math.min(40, span * 0.3));
    const axis = (to: [number, number, number], color: string) => {
      const g = this.geometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, ...to]), 3));
      const l = new LineSegments(
        g,
        this.material(new LineBasicMaterial({ color, depthTest: false, transparent: true })),
      );
      l.renderOrder = 12;
      l.frustumCulled = false;
      return l;
    };
    const gizmo = new Group();
    gizmo.name = 'cam-preview-wcs';
    gizmo.add(
      axis([length, 0, 0], '#e03131'),
      axis([0, length, 0], '#2f9e44'),
      axis([0, 0, length], '#1c7ed6'),
    );
    const dot = new Mesh(
      this.geometry(new SphereGeometry(Math.max(0.6, length * 0.05), 12, 8)),
      this.material(new MeshBasicMaterial({ color: '#222222', depthTest: false })),
    );
    dot.renderOrder = 12;
    gizmo.add(dot);
    this.root.add(gizmo);
  }

  /** The marker for a tool (made once per tool): its tip at the group's origin, pointing down. */
  private marker(tool: Tool | undefined): Group {
    const key = tool?.id ?? '';
    const existing = this.toolMarkers.get(key);
    if (existing) return existing;
    const d = tool && tool.diameter > 0 ? tool.diameter : 6;
    const r = d / 2;
    const height = Math.max(tool?.fluteLength ?? 0, d * 2);
    const material = this.material(
      new MeshStandardMaterial({ color: TOOL_COLOR, transparent: true, opacity: 0.85 }),
    );
    const group = new Group();
    group.name = 'cam-preview-tool';
    // three's cylinders and cones run along Y; turned so they run along machine Z.
    const upright = (mesh: Mesh, centreZ: number, flip = false) => {
      mesh.rotation.x = flip ? -Math.PI / 2 : Math.PI / 2;
      mesh.position.z = centreZ;
      group.add(mesh);
    };
    const kind = tool?.kind ?? 'flat';
    if (kind === 'vbit' || kind === 'engraver' || kind === 'drill') {
      const angle =
        tool?.angle && tool.angle > 0 && tool.angle < Math.PI ? tool.angle : Math.PI / 2;
      const coneHeight = Math.max(r / Math.tan(angle / 2), 0.1);
      upright(
        new Mesh(this.geometry(new ConeGeometry(r, coneHeight, 24)), material),
        coneHeight / 2,
        true,
      );
      upright(
        new Mesh(this.geometry(new CylinderGeometry(r, r, height, 24)), material),
        coneHeight + height / 2,
      );
    } else if (kind === 'ball') {
      const ball = new Mesh(this.geometry(new SphereGeometry(r, 24, 12)), material);
      ball.position.z = r;
      group.add(ball);
      upright(
        new Mesh(this.geometry(new CylinderGeometry(r, r, height, 24)), material),
        r + height / 2,
      );
    } else {
      upright(
        new Mesh(this.geometry(new CylinderGeometry(r, r, height, 24)), material),
        height / 2,
      );
    }
    for (const c of group.children) c.renderOrder = 4;
    this.toolMarkers.set(key, group);
    this.root.add(group);
    return group;
  }
}
