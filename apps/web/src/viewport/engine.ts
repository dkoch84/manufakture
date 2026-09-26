// The three.js viewport. Plain three.js, driven imperatively: React owns the
// canvas element and the toolbar, this class owns everything drawn on it.
//
// Per body there is one BufferGeometry shared by several meshes: the shaded
// faces (with per-vertex colours for hover and selection), a silhouette rim,
// the pick id pass, and two stencil passes that cap a section cut. Edges are
// fat lines (LineSegments2) drawn over polygon-offset faces. The pick scene
// also holds each body's edges (1 px lines) and vertices (points), so edge
// and vertex picking is depth-tested like face picking (see picking.ts).
//
// Rendering is on demand: a frame is drawn only when something changed, so an
// idle viewport costs nothing.

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DecrementWrapStencilOp,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  BackSide,
  AlwaysStencilFunc,
  IncrementWrapStencilOp,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NotEqualStencilFunc,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  PlaneGeometry,
  Points,
  PointsMaterial,
  CanvasTexture,
  ReplaceStencilOp,
  Scene,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Camera,
  type Material,
  type ShaderMaterial,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '@manufakture/kernel';
import {
  isFeatureItem,
  isGeometryRef,
  selectModeFor,
  type GeometryKind,
  type GeometryRef,
  type SelectionState,
  type SelectionStore,
} from '../state/selection';
import type { SectionSettings, ViewSettingsState, ViewSettingsStore } from '../state/viewSettings';
import {
  edgePickIds,
  pickIdAttribute,
  prepareBodies,
  vertexPickPoints,
  unionBounds,
  type BodyInput,
  type ViewBody,
} from './bodies';
import { gridCenter, gridLevels } from './grid';
import { createGridMaterial, createPickMaterial, createSilhouetteMaterial } from './materials';
import { PLACEHOLDER_PREFIX, nameFromFeature } from './naming';
import {
  NO_MODIFIERS,
  PRESETS,
  dragAction,
  wheelDeltaPixels,
  wheelZoomFactor,
  type Modifiers,
  type NavAction,
} from './navigation';
import {
  PICK_TOLERANCE_PX,
  choosePick,
  edgeCandidates,
  hitToRef,
  readPickWindow,
  vertexCandidates,
  type Candidate,
} from './picking';
import { ViewCube } from './viewCube';
import {
  STANDARD_VIEWS,
  cloneView,
  eyeDirection,
  fitSphere,
  interpolateView,
  orbit,
  orientationFor,
  pan,
  panDepthScale,
  perspectiveDistance,
  withDirection,
  worldPerPixel,
  zoomAbout,
  zoomAt,
  type StandardView,
  type Vec3Tuple,
  type ViewState,
} from './viewMath';

const FOV = 35;
const TRANSITION_MS = 350;
const CLICK_SLOP_PX = 4;

const COLORS = {
  background: new Color(0xf4f6f8),
  face: new Color(0xc2cad3),
  faceHover: new Color(0x9cc3ff),
  faceSelected: new Color(0x4d8dff),
  edge: new Color(0x1f2733),
  edgeHover: new Color(0x3d8bff),
  edgeSelected: new Color(0x0b5cff),
  cap: new Color(0xe0875e),
};

type Highlight = 'none' | 'hover' | 'selected';

interface BodyObjects {
  body: ViewBody;
  geometry: BufferGeometry;
  colors: BufferAttribute;
  faceState: Highlight[];
  faceByName: Map<string, number>;
  edgeByName: Map<string, number>;
  meshes: Mesh[];
  edges: LineSegments2;
  edgeGeometry: LineSegmentsGeometry;
  /** Edges and vertices in the pick scene. */
  pickEdges: LineSegments<BufferGeometry, ShaderMaterial>;
  pickVertices: Points<BufferGeometry, ShaderMaterial>;
  /** Projected segments (x0 y0 x1 y1) and vertices (x y), cached per camera version. */
  screenSegments: Float32Array;
  screenVertices: Float32Array;
  screenVersion: number;
}

export interface FrameStats {
  frames: number;
  triangles: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  /** Mean CPU time spent inside renderer.render per frame (not GPU time). */
  renderCpuMs: number;
}

/** One edge or vertex as the pick pass would name it, for tests and tooling. */
export interface GeometrySample {
  bodyId: string;
  kind: 'edge' | 'vertex';
  /** The name `pickAt` reports for it. */
  name: string;
  /** Polyline of an edge (one point for a vertex). */
  points: Vec3[];
}

export interface EngineStores {
  selection: SelectionStore;
  settings: ViewSettingsStore;
}

/** A canvas point in CSS pixels from the canvas's top left. */
export interface CanvasPoint {
  x: number;
  y: number;
}

/**
 * Takes over left-button input while a tool (the sketcher) is active. The
 * view cube and the navigation buttons keep working; 3D hover and selection
 * are off while a delegate is set.
 */
export interface PointerDelegate {
  /** A left-button press. Return true to take it and the drag that follows. */
  down(e: PointerEvent, p: CanvasPoint): boolean;
  /** Every move that is not a navigation drag, pressed or not. */
  move(e: PointerEvent, p: CanvasPoint): void;
  /** The release of a press the delegate took. */
  up(e: PointerEvent, p: CanvasPoint): void;
  dblclick?(e: MouseEvent, p: CanvasPoint): void;
  /** The pointer left the canvas. */
  leave?(): void;
}

export class ViewportEngine {
  readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly pickScene = new Scene();
  private readonly perspective = new PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, 0, 1000);
  private readonly light = new DirectionalLight(0xffffff, 2.2);
  private readonly cube = new ViewCube();
  private readonly pickTarget: WebGLRenderTarget;
  private readonly pickSize = PICK_TOLERANCE_PX * 2 + 1;
  private readonly pickPixels: Uint8Array;
  private readonly raycaster = new Raycaster();
  private readonly clipPlane = new Plane(new Vector3(0, -1, 0), 0);
  /** Shared by every clipped material; holds zero or one plane. */
  private readonly clipPlanes: Plane[] = [];
  private readonly grid: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly cap: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private readonly faceMaterial: MeshStandardMaterial;
  private readonly silhouetteMaterial: ShaderMaterial;
  private readonly pickMaterial: ShaderMaterial;
  private readonly pickEdgeMaterial: ShaderMaterial;
  private readonly pickVertexMaterial: ShaderMaterial;
  private readonly stencilBack: MeshBasicMaterial;
  private readonly stencilFront: MeshBasicMaterial;
  private readonly edgeMaterial: LineMaterial;
  private readonly hoverEdgeMaterial: LineMaterial;
  private readonly selectedEdgeMaterial: LineMaterial;
  private readonly hoverEdges = new LineSegments2(new LineSegmentsGeometry());
  private readonly selectedEdges = new LineSegments2(new LineSegmentsGeometry());
  private readonly vertexMarkers: Points<BufferGeometry, PointsMaterial>;

  private bodies: BodyObjects[] = [];
  private view: ViewState = {
    target: new Vector3(),
    orientation: orientationFor(STANDARD_VIEWS.iso),
    halfHeight: 50,
  };
  private sceneSphere = { center: new Vector3(), radius: 50 };
  private transition: { from: ViewState; to: ViewState; start: number } | null = null;
  private width = 1;
  private height = 1;
  private dirty = true;
  private cameraVersion = 0;
  private frameHandle = 0;
  private disposed = false;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly resizeObserver: ResizeObserver | null;

  // Pointer state
  private pointer: { x: number; y: number } | null = null;
  private hoverPending = false;
  /** Wheel zoom collected since the last frame: raycast for the pivot once per frame. */
  private wheelZoom: { x: number; y: number; factor: number } | null = null;
  private drag: {
    x: number;
    y: number;
    startX: number;
    startY: number;
    buttons: number;
    moved: boolean;
    action: NavAction;
    onCube: boolean;
    /** Depth of the grabbed model point, measured when a pan starts. */
    panScale: number | null;
  } | null = null;
  private benchmark: ((now: number) => void) | null = null;
  private delegate: PointerDelegate | null = null;
  /** The delegate took the current press. */
  private delegated = false;
  private readonly viewListeners = new Set<() => void>();
  private notifiedVersion = -1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly stores: EngineStores,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(COLORS.background, 1);

    this.pickTarget = new WebGLRenderTarget(this.pickSize, this.pickSize);
    this.pickPixels = new Uint8Array(this.pickSize * this.pickSize * 4);

    this.scene.add(new AmbientLight(0xffffff, 0.9));
    this.scene.add(this.light);
    this.scene.add(this.light.target);

    this.faceMaterial = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      clippingPlanes: this.clipPlanes,
      side: FrontSide,
    });
    this.silhouetteMaterial = createSilhouetteMaterial(this.clipPlanes, COLORS.edge);
    this.pickMaterial = createPickMaterial(this.clipPlanes);
    this.pickEdgeMaterial = createPickMaterial(this.clipPlanes, 'lines');
    this.pickVertexMaterial = createPickMaterial(this.clipPlanes, 'points');
    const stencilBase = {
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: AlwaysStencilFunc,
      clippingPlanes: this.clipPlanes,
    } as const;
    this.stencilBack = new MeshBasicMaterial({
      ...stencilBase,
      side: BackSide,
      stencilFail: IncrementWrapStencilOp,
      stencilZFail: IncrementWrapStencilOp,
      stencilZPass: IncrementWrapStencilOp,
    });
    this.stencilFront = new MeshBasicMaterial({
      ...stencilBase,
      side: FrontSide,
      stencilFail: DecrementWrapStencilOp,
      stencilZFail: DecrementWrapStencilOp,
      stencilZPass: DecrementWrapStencilOp,
    });
    const lineMaterial = (color: Color, linewidth: number) =>
      new LineMaterial({ color: color.getHex(), linewidth, clippingPlanes: this.clipPlanes });
    this.edgeMaterial = lineMaterial(COLORS.edge, 1.25);
    this.hoverEdgeMaterial = lineMaterial(COLORS.edgeHover, 3);
    this.selectedEdgeMaterial = lineMaterial(COLORS.edgeSelected, 3);
    this.hoverEdges.material = this.hoverEdgeMaterial;
    this.selectedEdges.material = this.selectedEdgeMaterial;
    this.hoverEdges.renderOrder = 6;
    this.selectedEdges.renderOrder = 5;
    this.scene.add(this.selectedEdges, this.hoverEdges);

    this.vertexMarkers = new Points(
      new BufferGeometry(),
      new PointsMaterial({
        size: 11,
        sizeAttenuation: false,
        vertexColors: true,
        map: dotTexture(),
        alphaTest: 0.5,
        depthTest: false,
        transparent: true,
      }),
    );
    this.vertexMarkers.renderOrder = 7;
    this.vertexMarkers.frustumCulled = false;
    this.scene.add(this.vertexMarkers);

    this.grid = new Mesh(new PlaneGeometry(1, 1), createGridMaterial());
    this.grid.renderOrder = 10;
    this.grid.frustumCulled = false;
    this.scene.add(this.grid);

    this.cap = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshStandardMaterial({
        color: COLORS.cap,
        roughness: 0.8,
        side: DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: NotEqualStencilFunc,
        stencilFail: ReplaceStencilOp,
        stencilZFail: ReplaceStencilOp,
        stencilZPass: ReplaceStencilOp,
      }),
    );
    this.cap.renderOrder = 2;
    this.cap.onAfterRender = (renderer) => renderer.clearStencil();
    this.cap.visible = false;
    this.scene.add(this.cap);

    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    this.resize();
    this.attachEvents();
    this.unsubscribe.push(
      stores.selection.subscribe((s, prev) => this.onSelection(s, prev)),
      stores.settings.subscribe((s, prev) => this.onSettings(s, prev)),
    );
    this.applySettings(stores.settings.getState());
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  // Public API -------------------------------------------------------------------------

  setBodies(inputs: readonly BodyInput[], fit = true): void {
    this.clearBodies();
    const prepared = prepareBodies(inputs);
    this.bodies = prepared.map((body) => this.buildBody(body));
    const bounds = unionBounds(prepared);
    if (bounds) {
      const min = new Vector3(...bounds.min);
      const max = new Vector3(...bounds.max);
      this.sceneSphere = {
        center: min.clone().add(max).multiplyScalar(0.5),
        radius: Math.max(min.distanceTo(max) / 2, 1e-3),
      };
    }
    // New edge objects start visible: apply Show edges and the section to them.
    this.applySettings(this.stores.settings.getState());
    this.refreshHighlights();
    // Names may have changed: drop selections that no longer resolve.
    this.stores.selection.getState().prune((item) => !isGeometryRef(item) || this.resolves(item));
    if (fit) this.fitAll(false);
    this.invalidate(true);
  }

  setStandardView(name: StandardView, animate = true): void {
    this.setViewDirection(STANDARD_VIEWS[name], animate);
  }

  setViewDirection(dir: Vec3Tuple, animate = true): void {
    const to = withDirection(this.currentView(), dir);
    // Also frame the model, as Onshape does for the named views.
    this.goTo(fitSphere(to, this.sceneSphere, this.aspect()), animate);
  }

  fitAll(animate = true): void {
    this.goTo(fitSphere(this.currentView(), this.sceneSphere, this.aspect()), animate);
  }

  /** What is under a canvas point (CSS pixels from the canvas's top left). */
  pickAt(x: number, y: number): GeometryRef | null {
    if (this.bodies.length === 0) return null;
    const views = this.bodies.map((b) => b.body);
    const selection = this.stores.selection.getState();
    const enabled = (k: GeometryKind) => selection.isKindEnabled(k);
    // Kinds the filter excludes stay out of the pick pass, so they cannot
    // cover the face under them.
    for (const b of this.bodies) {
      b.pickEdges.visible = enabled('edge');
      b.pickVertices.visible = enabled('vertex');
    }
    const window = this.renderPickWindow(x, y);
    const edges: Candidate[] = [];
    const vertices: Candidate[] = [];
    this.bodies.forEach((b, i) => {
      this.projectBody(b);
      edges.push(
        ...edgeCandidates(i, b.screenSegments, b.body.segmentEdges, { x, y }, PICK_TOLERANCE_PX),
      );
      vertices.push(...vertexCandidates(i, b.screenVertices, { x, y }, PICK_TOLERANCE_PX));
    });
    const hit = choosePick({ window, edges, vertices }, enabled);
    return hit ? hitToRef(views, hit) : null;
  }

  /**
   * Every edge and vertex with the name `pickAt` reports for it. For tests
   * and tooling, with `hiddenDepth`: together they tell which geometry is
   * hidden, independently of the pick pass.
   */
  geometrySamples(): GeometrySample[] {
    const out: GeometrySample[] = [];
    const views = this.bodies.map((b) => b.body);
    views.forEach((body, i) => {
      for (let e = 1; e <= body.edgeCount; e++) {
        const ref = hitToRef(views, { kind: 'edge', body: i, index: e });
        const points: Vec3[] = [];
        for (let s = 0; s < body.segmentEdges.length; s++) {
          if (body.segmentEdges[s] !== e) continue;
          const p = body.segments.subarray(s * 6, s * 6 + 6);
          if (points.length === 0) points.push([p[0]!, p[1]!, p[2]!]);
          points.push([p[3]!, p[4]!, p[5]!]);
        }
        if (ref && points.length > 0)
          out.push({ bodyId: body.id, kind: 'edge', name: ref.name, points });
      }
      for (const v of body.vertices) {
        const ref = hitToRef(views, { kind: 'vertex', body: i, index: v.index });
        if (ref) out.push({ bodyId: body.id, kind: 'vertex', name: ref.name, points: [v.point] });
      }
    });
    return out;
  }

  /**
   * For each world point, how far (in model units) it lies behind the
   * nearest visible face along the line of sight: 0 when nothing covers it,
   * Infinity when it is cut away by the section. Ray-cast on the CPU, so it
   * checks the GPU pick pass independently. For tests and tooling.
   *
   * With `marginPx`, the point is also displaced by that many CSS pixels on
   * screen in eight directions (at the same view depth) and the smallest
   * result counts: a point hidden only just behind a silhouette, closer than
   * a pixel or two, reports as barely hidden.
   */
  hiddenDepth(points: readonly Vec3[], marginPx = 0): number[] {
    this.updateCameras();
    const camera = this.activeCamera();
    const faces = this.bodies.map((b) => b.meshes[2]!);
    const clipped = (q: Vector3) =>
      this.clipPlanes.length > 0 && this.clipPlane.distanceToPoint(q) < 0;
    const depthOf = (q: Vector3, ndc: Vector3): number => {
      if (clipped(q)) return Infinity;
      this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
      const along = q.clone().sub(this.raycaster.ray.origin).dot(this.raycaster.ray.direction);
      for (const hit of this.raycaster.intersectObjects(faces, false)) {
        if (clipped(hit.point)) continue;
        return Math.max(0, along - hit.distance);
      }
      return 0;
    };
    const offsets: [number, number][] = [[0, 0]];
    if (marginPx > 0) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        offsets.push([Math.cos(a) * marginPx, Math.sin(a) * marginPx]);
      }
    }
    return points.map((point) => {
      const ndc = new Vector3(...point).project(camera);
      let least = Infinity;
      for (const [dx, dy] of offsets) {
        const shifted = ndc.clone();
        shifted.x += (2 * dx) / this.width;
        shifted.y -= (2 * dy) / this.height;
        const q = shifted.clone().unproject(camera);
        least = Math.min(least, depthOf(q, shifted));
      }
      return least;
    });
  }

  /** A world point in client (page viewport) coordinates, for tests and tooling. */
  projectToClient(p: Vec3): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const v = new Vector3(...p).project(this.activeCamera());
    return {
      x: rect.left + ((v.x + 1) / 2) * this.width,
      y: rect.top + ((1 - v.y) / 2) * this.height,
    };
  }

  /** A world point in canvas coordinates (CSS pixels), in the view last drawn. */
  projectToCanvas(p: Vec3): CanvasPoint {
    const v = new Vector3(...p).project(this.activeCamera());
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /**
   * The world point where the line of sight through a canvas point meets the
   * plane through `origin` with `normal`, or null when it runs parallel.
   */
  canvasToPlane(x: number, y: number, origin: Vec3, normal: Vec3): Vec3 | null {
    const ndc = this.ndc(x, y);
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), this.activeCamera());
    const plane = new Plane().setFromNormalAndCoplanarPoint(
      new Vector3(...normal).normalize(),
      new Vector3(...origin),
    );
    const ray = this.raycaster.ray;
    const denom = plane.normal.dot(ray.direction);
    if (Math.abs(denom) < 1e-9) return null;
    // Behind the camera is fine: an orthographic ray starts far in front of the plane.
    const t = -(ray.origin.dot(plane.normal) + plane.constant) / denom;
    const hit = ray.origin.clone().addScaledVector(ray.direction, t);
    return [hit.x, hit.y, hit.z];
  }

  /**
   * Look along `-eye` (the camera sits on the `eye` side) with `up` pointing
   * up on screen, centred on `target`. The zoom is kept.
   */
  alignView(eye: Vec3, up: Vec3, target: Vec3, animate = true): void {
    const to: ViewState = {
      target: new Vector3(...target),
      orientation: orientationFor(eye, new Vector3(...up)),
      halfHeight: this.currentView().halfHeight,
    };
    this.goTo(to, animate);
  }

  /** Hand left-button input to a tool, or take it back with null. */
  setPointerDelegate(delegate: PointerDelegate | null): void {
    this.delegate = delegate;
    this.delegated = false;
    if (delegate) this.stores.selection.getState().setHovered(null);
    this.hoverPending = true;
  }

  /**
   * Call `listener` after every frame drawn with a changed camera or canvas
   * size, so overlays can follow the view. Returns the unsubscribe function.
   */
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  /** Redraw on the next frame (overlays that changed call it). */
  requestRender(): void {
    this.invalidate();
  }

  info() {
    return {
      bodies: this.bodies.map((b) => ({
        id: b.body.id,
        faces: b.body.faceCount,
        edges: b.body.edgeCount,
        triangles: b.body.mesh.indices.length / 3,
      })),
      projection: this.stores.settings.getState().projection,
      halfHeight: this.view.halfHeight,
      animating: this.transition !== null || this.wheelZoom !== null,
      size: { width: this.width, height: this.height },
    };
  }

  /**
   * Render `frames` frames back to back while orbiting, and report frame
   * times. Frame time is the interval between animation frames, so it is
   * capped by the display refresh rate; `renderCpuMs` is the CPU side only.
   */
  measureFrames(frames = 240): Promise<FrameStats> {
    return new Promise((resolve) => {
      const intervals: number[] = [];
      let cpu = 0;
      let last = -1;
      let count = 0;
      this.benchmark = (now) => {
        if (last >= 0) intervals.push(now - last);
        last = now;
        this.view = orbit(this.view, 2, 0);
        this.cameraVersion++;
        const t0 = performance.now();
        this.render();
        cpu += performance.now() - t0;
        if (++count > frames) {
          this.benchmark = null;
          const sorted = [...intervals].sort((a, b) => a - b);
          const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
          const q = (p: number) =>
            sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
          resolve({
            frames: intervals.length,
            triangles: this.bodies.reduce((n, b) => n + b.body.mesh.indices.length / 3, 0),
            meanMs: mean,
            p50Ms: q(0.5),
            p95Ms: q(0.95),
            maxMs: sorted[sorted.length - 1]!,
            fps: 1000 / mean,
            renderCpuMs: cpu / count,
          });
        }
      };
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    this.detachEvents();
    for (const u of this.unsubscribe) u();
    this.clearBodies();
    this.cube.dispose();
    const materials: Material[] = [
      this.faceMaterial,
      this.silhouetteMaterial,
      this.pickMaterial,
      this.pickEdgeMaterial,
      this.pickVertexMaterial,
      this.stencilBack,
      this.stencilFront,
      this.edgeMaterial,
      this.hoverEdgeMaterial,
      this.selectedEdgeMaterial,
      this.vertexMarkers.material,
      this.grid.material,
      this.cap.material,
    ];
    for (const m of materials) m.dispose();
    this.vertexMarkers.material.map?.dispose();
    this.hoverEdges.geometry.dispose();
    this.selectedEdges.geometry.dispose();
    this.vertexMarkers.geometry.dispose();
    this.grid.geometry.dispose();
    this.cap.geometry.dispose();
    this.pickTarget.dispose();
    this.renderer.dispose();
  }

  // Bodies ------------------------------------------------------------------------------

  private buildBody(body: ViewBody): BodyObjects {
    const { mesh } = body;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(body.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(body.normals, 3));
    geometry.setIndex(new BufferAttribute(body.indices, 1));
    geometry.setAttribute('pickId', new BufferAttribute(pickIdAttribute(body), 1));
    const vertexCount = body.positions.length / 3;
    const colors = new BufferAttribute(new Uint8Array(vertexCount * 3), 3, true);
    fillColor(colors, [0, vertexCount], COLORS.face);
    geometry.setAttribute('color', colors);
    geometry.computeBoundingSphere();

    const make = (material: Material, order: number, scene: Scene = this.scene) => {
      const m = new Mesh(geometry, material);
      m.renderOrder = order;
      scene.add(m);
      return m;
    };
    const meshes = [
      make(this.stencilBack, 1),
      make(this.stencilFront, 1),
      make(this.faceMaterial, 3),
      make(this.silhouetteMaterial, 3),
      make(this.pickMaterial, 0, this.pickScene),
    ];

    const edgeGeometry = new LineSegmentsGeometry();
    if (body.segments.length > 0) edgeGeometry.setPositions(body.segments);
    const edges = new LineSegments2(edgeGeometry, this.edgeMaterial);
    edges.renderOrder = 4;
    this.scene.add(edges);

    const pickEdgeGeometry = new BufferGeometry();
    pickEdgeGeometry.setAttribute('position', new BufferAttribute(body.segments, 3));
    pickEdgeGeometry.setAttribute('pickId', new BufferAttribute(edgePickIds(body), 1));
    const pickEdges = new LineSegments(pickEdgeGeometry, this.pickEdgeMaterial);
    const points = vertexPickPoints(body);
    const pickVertexGeometry = new BufferGeometry();
    pickVertexGeometry.setAttribute('position', new BufferAttribute(points.positions, 3));
    pickVertexGeometry.setAttribute('pickId', new BufferAttribute(points.ids, 1));
    const pickVertices = new Points(pickVertexGeometry, this.pickVertexMaterial);
    // The pick window is a few pixels wide: culling against it saves nothing
    // and needs bounding spheres.
    pickEdges.frustumCulled = false;
    pickVertices.frustumCulled = false;
    this.pickScene.add(pickEdges, pickVertices);

    const index = (slots: Uint32Array) => {
      const map = new Map<string, number>();
      slots.forEach((slot, i) => {
        const name = body.names[slot];
        if (name !== undefined) map.set(name, i + 1);
      });
      return map;
    };
    return {
      body,
      geometry,
      colors,
      faceState: new Array<Highlight>(body.faceCount).fill('none'),
      faceByName: index(mesh.faceNames),
      edgeByName: index(mesh.edgeNames),
      meshes,
      edges,
      edgeGeometry,
      pickEdges,
      pickVertices,
      screenSegments: new Float32Array(body.segmentEdges.length * 4),
      screenVertices: new Float32Array(body.vertices.length * 2),
      screenVersion: -1,
    };
  }

  private clearBodies(): void {
    for (const b of this.bodies) {
      for (const m of b.meshes) m.removeFromParent();
      b.edges.removeFromParent();
      b.pickEdges.removeFromParent();
      b.pickVertices.removeFromParent();
      b.geometry.dispose();
      b.edgeGeometry.dispose();
      b.pickEdges.geometry.dispose();
      b.pickVertices.geometry.dispose();
    }
    this.bodies = [];
  }

  private resolves(ref: GeometryRef): boolean {
    return this.locate(ref) !== null;
  }

  /** The body and 1-based index a reference names, or null. */
  private locate(ref: GeometryRef): { body: BodyObjects; index: number } | null {
    const body = this.bodies.find((b) => b.body.id === ref.bodyId);
    if (!body) return null;
    let index: number | undefined;
    if (ref.kind === 'face') index = body.faceByName.get(ref.name);
    else if (ref.kind === 'edge') index = body.edgeByName.get(ref.name);
    else {
      const prefix = `${PLACEHOLDER_PREFIX}vertex:`;
      const n = ref.name.startsWith(prefix) ? Number(ref.name.slice(prefix.length)) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= body.body.vertices.length) index = n;
    }
    return index === undefined ? null : { body, index };
  }

  // Highlights ------------------------------------------------------------------------

  private onSelection(s: SelectionState, prev: SelectionState): void {
    if (s.selected === prev.selected && s.hovered === prev.hovered) return;
    this.refreshHighlights();
  }

  private refreshHighlights(): void {
    const { selected, hovered } = this.stores.selection.getState();
    const wanted = new Map<BodyObjects, Map<number, Highlight>>();
    const edgeSets = { hover: [] as number[], selected: [] as number[] };
    const vertexPoints: { p: Vec3; c: Color }[] = [];
    const mark = (item: GeometryRef, h: Exclude<Highlight, 'none'>) => {
      const found = this.locate(item);
      if (!found) return;
      const { body, index } = found;
      if (item.kind === 'face') {
        let m = wanted.get(body);
        if (!m) wanted.set(body, (m = new Map()));
        if (m.get(index) !== 'selected') m.set(index, h);
      } else if (item.kind === 'edge') {
        appendEdgeSegments(body.body, index, edgeSets[h]);
      } else {
        const v = body.body.vertices[index - 1];
        if (v)
          vertexPoints.push({
            p: v.point,
            c: h === 'hover' ? COLORS.edgeHover : COLORS.edgeSelected,
          });
      }
    };
    for (const item of selected) if (isGeometryRef(item)) mark(item, 'selected');
    if (hovered && isGeometryRef(hovered)) mark(hovered, 'hover');
    // A feature hovered in the feature tree: every face it made.
    if (isFeatureItem(hovered)) {
      for (const b of this.bodies) {
        for (const [name, index] of b.faceByName) {
          if (!nameFromFeature(name, hovered.id)) continue;
          let m = wanted.get(b);
          if (!m) wanted.set(b, (m = new Map()));
          if (m.get(index) !== 'selected') m.set(index, 'hover');
        }
      }
    }

    for (const b of this.bodies) {
      const w = wanted.get(b);
      let changed = false;
      for (let f = 1; f <= b.body.faceCount; f++) {
        const next = w?.get(f) ?? 'none';
        if (b.faceState[f - 1] === next) continue;
        b.faceState[f - 1] = next;
        const color =
          next === 'selected'
            ? COLORS.faceSelected
            : next === 'hover'
              ? COLORS.faceHover
              : COLORS.face;
        const list = b.body.faceVertexList.subarray(
          b.body.faceVertexOffsets[f - 1],
          b.body.faceVertexOffsets[f],
        );
        if (list.length === 0) continue;
        fillColor(b.colors, list, color);
        const start = b.body.faceVertexStart[f - 1]!;
        const end = b.body.faceVertexEnd[f - 1]!;
        b.colors.addUpdateRange(start * 3, (end - start) * 3);
        changed = true;
      }
      if (changed) b.colors.needsUpdate = true;
    }
    setSegments(this.hoverEdges, edgeSets.hover);
    setSegments(this.selectedEdges, edgeSets.selected);

    const positions = new Float32Array(vertexPoints.length * 3);
    const colors = new Float32Array(vertexPoints.length * 3);
    vertexPoints.forEach((v, i) => {
      positions.set(v.p, i * 3);
      colors.set([v.c.r, v.c.g, v.c.b], i * 3);
    });
    this.vertexMarkers.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    this.vertexMarkers.geometry = g;
    this.invalidate();
  }

  // Settings ---------------------------------------------------------------------------

  private onSettings(s: ViewSettingsState, prev: ViewSettingsState): void {
    if (s.projection !== prev.projection) this.cameraVersion++;
    this.applySettings(s);
  }

  private applySettings(s: ViewSettingsState): void {
    for (const b of this.bodies) b.edges.visible = s.showEdges;
    this.grid.visible = s.showGrid;
    this.applySection(s.section);
    this.invalidate(true);
  }

  private applySection(section: SectionSettings): void {
    const bounds = unionBounds(this.bodies.map((b) => b.body));
    const enabled = section.enabled && bounds !== null;
    this.clipPlanes.length = 0;
    for (const b of this.bodies) {
      b.meshes[0]!.visible = enabled;
      b.meshes[1]!.visible = enabled;
    }
    this.cap.visible = enabled;
    if (!enabled || !bounds) return;
    const axis = { x: 0, y: 1, z: 2 }[section.axis];
    const lo = bounds.min[axis]!;
    const hi = bounds.max[axis]!;
    // Keep a hair inside the bounds, so an end position still cuts something visible.
    const at = lo + (hi - lo) * Math.min(0.999, Math.max(0.001, section.position));
    // Unflipped, keep the side away from the default iso eye, so the cut
    // face (and its cap) faces the viewer in the default view.
    const side = -Math.sign(STANDARD_VIEWS.iso[axis]!) * (section.flipped ? -1 : 1);
    const normal = new Vector3();
    normal.setComponent(axis, side);
    // three.js keeps points with normal . p + constant >= 0, here side * (p - at) >= 0.
    this.clipPlane.set(normal, -side * at);
    this.clipPlanes.push(this.clipPlane);

    const size = new Vector3(...bounds.max).sub(new Vector3(...bounds.min)).length() * 1.5 + 1;
    const center = new Vector3(...bounds.min).add(new Vector3(...bounds.max)).multiplyScalar(0.5);
    center.setComponent(axis, at);
    this.cap.position.copy(center);
    this.cap.scale.set(size, size, 1);
    this.cap.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    this.cap.updateMatrixWorld();
  }

  // Camera -----------------------------------------------------------------------------

  private aspect(): number {
    return this.width / Math.max(1, this.height);
  }

  private currentView(): ViewState {
    return cloneView(this.transition ? this.transition.to : this.view);
  }

  private goTo(to: ViewState, animate: boolean): void {
    if (animate) {
      this.transition = { from: cloneView(this.view), to, start: performance.now() };
    } else {
      this.transition = null;
      this.view = to;
    }
    this.invalidate(true);
  }

  private activeCamera(): PerspectiveCamera | OrthographicCamera {
    return this.stores.settings.getState().projection === 'perspective'
      ? this.perspective
      : this.orthographic;
  }

  private updateCameras(): void {
    const { target, orientation, halfHeight } = this.view;
    const eye = eyeDirection(orientation);
    const aspect = this.aspect();
    const r = this.sceneSphere.radius;
    const toScene = (pos: Vector3) => pos.distanceTo(this.sceneSphere.center);

    const dist = perspectiveDistance(halfHeight, FOV);
    const p = this.perspective;
    p.position.copy(target).addScaledVector(eye, dist);
    p.quaternion.copy(orientation);
    p.aspect = aspect;
    const d = toScene(p.position);
    p.near = Math.max(dist * 1e-3, d - r * 1.5);
    p.far = Math.max(d + r * 1.5, dist * 20);
    p.updateProjectionMatrix();
    p.updateMatrixWorld();

    const o = this.orthographic;
    const back = r * 3 + halfHeight * 4;
    o.position.copy(target).addScaledVector(eye, back);
    o.quaternion.copy(orientation);
    o.left = -halfHeight * aspect;
    o.right = halfHeight * aspect;
    o.top = halfHeight;
    o.bottom = -halfHeight;
    o.near = 0;
    o.far = back + toScene(o.position) + r * 3 + halfHeight * 20;
    o.updateProjectionMatrix();
    o.updateMatrixWorld();

    // Headlight from above the viewer's right shoulder.
    const camera = this.activeCamera();
    this.light.position
      .copy(camera.position)
      .addScaledVector(new Vector3(1, 1, 0).applyQuaternion(orientation), halfHeight);
    this.light.target.position.copy(target);
    this.light.target.updateMatrixWorld();

    const levels = gridLevels(worldPerPixel(halfHeight, this.height));
    const [cx, cy] = gridCenter(target.x, target.y, levels.major);
    const u = this.grid.material.uniforms;
    u.uMinor!.value = levels.minor;
    u.uMajor!.value = levels.major;
    u.uMinorFade!.value = levels.minorFade;
    u.uExtent!.value = levels.extent;
    (u.uCenter!.value as { set(x: number, y: number): void }).set(target.x, target.y);
    this.grid.position.set(cx, cy, 0);
    this.grid.scale.set(levels.extent, levels.extent, 1);
  }

  // Rendering --------------------------------------------------------------------------

  private invalidate(camera = false): void {
    if (camera) this.cameraVersion++;
    this.dirty = true;
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    if (this.benchmark) {
      this.benchmark(now);
      return;
    }
    // Also polled here: a ResizeObserver callback can arrive a frame late.
    this.resize();
    if (this.transition) {
      const t = (now - this.transition.start) / TRANSITION_MS;
      this.view = interpolateView(this.transition.from, this.transition.to, Math.max(0, t));
      if (t >= 1) {
        this.view = this.transition.to;
        this.transition = null;
      }
      this.cameraVersion++;
      this.dirty = true;
    }
    if (this.wheelZoom) this.applyWheelZoom();
    if (this.hoverPending && !this.drag) {
      this.hoverPending = false;
      this.updateHover();
    }
    if (this.dirty) this.render();
  };

  private render(): void {
    this.dirty = false;
    this.updateCameras();
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.width, this.height);
    r.clear(true, true, true);
    r.render(this.scene, this.activeCamera());
    this.cube.render(r, this.width, this.height, this.view.orientation);
    if (this.notifiedVersion !== this.cameraVersion) {
      this.notifiedVersion = this.cameraVersion;
      for (const l of this.viewListeners) l();
    }
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const m of [this.edgeMaterial, this.hoverEdgeMaterial, this.selectedEdgeMaterial]) {
      m.resolution.set(w, h);
    }
    (
      this.silhouetteMaterial.uniforms.uResolution!.value as { set(x: number, y: number): void }
    ).set(w, h);
    this.invalidate(true);
  }

  // Picking ----------------------------------------------------------------------------

  private renderPickWindow(x: number, y: number) {
    this.updateCameras();
    const camera = this.activeCamera();
    // Offset by half a pixel so the centre pixel is centred on the cursor and
    // pixel distances in the window are distances from the cursor.
    const half = PICK_TOLERANCE_PX + 0.5;
    camera.setViewOffset(this.width, this.height, x - half, y - half, this.pickSize, this.pickSize);
    const r = this.renderer;
    const clear = r.getClearColor(new Color());
    const alpha = r.getClearAlpha();
    r.setRenderTarget(this.pickTarget);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(this.pickScene, camera);
    r.readRenderTargetPixels(this.pickTarget, 0, 0, this.pickSize, this.pickSize, this.pickPixels);
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
    camera.clearViewOffset();
    return readPickWindow(
      this.pickPixels,
      this.pickSize,
      this.bodies.map((b) => b.body),
    );
  }

  /** Project a body's edge segments and vertices to CSS pixels, once per camera change. */
  private projectBody(b: BodyObjects): void {
    if (b.screenVersion === this.cameraVersion) return;
    b.screenVersion = this.cameraVersion;
    const camera: Camera = this.activeCamera();
    const v = new Vector3();
    const clipped = (x: number, y: number, z: number) =>
      this.clipPlanes.length > 0 && this.clipPlane.distanceToPoint(v.set(x, y, z)) < 0;
    const project = (x: number, y: number, z: number, out: Float32Array, o: number) => {
      v.set(x, y, z).project(camera);
      if (v.z < -1 || v.z > 1) {
        out[o] = NaN;
        return;
      }
      out[o] = ((v.x + 1) / 2) * this.width;
      out[o + 1] = ((1 - v.y) / 2) * this.height;
    };
    const seg = b.body.segments;
    const out = b.screenSegments;
    for (let s = 0; s < b.body.segmentEdges.length; s++) {
      const i = s * 6;
      if (
        clipped(seg[i]!, seg[i + 1]!, seg[i + 2]!) &&
        clipped(seg[i + 3]!, seg[i + 4]!, seg[i + 5]!)
      ) {
        out[s * 4] = NaN;
        continue;
      }
      project(seg[i]!, seg[i + 1]!, seg[i + 2]!, out, s * 4);
      project(seg[i + 3]!, seg[i + 4]!, seg[i + 5]!, out, s * 4 + 2);
      if (Number.isNaN(out[s * 4 + 2]!)) out[s * 4] = NaN;
    }
    b.body.vertices.forEach((vertex, i) => {
      const [x, y, z] = vertex.point;
      if (clipped(x, y, z)) b.screenVertices[i * 2] = NaN;
      else project(x, y, z, b.screenVertices, i * 2);
    });
  }

  private updateHover(): void {
    const selection = this.stores.selection.getState();
    const p = this.pointer;
    const cubeChanged = this.cube.hover(this.width, p?.x ?? null, p?.y ?? null);
    if (cubeChanged) this.invalidate();
    if (!p || this.cube.contains(this.width, p.x, p.y)) {
      selection.setHovered(null);
      this.canvas.style.cursor = p ? 'pointer' : '';
      return;
    }
    if (this.delegate) {
      // The tool owns hover and the cursor.
      selection.setHovered(null);
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const ref = this.pickAt(p.x, p.y);
    selection.setHovered(ref);
    this.canvas.style.cursor = ref ? 'pointer' : '';
  }

  // Events -----------------------------------------------------------------------------

  private readonly listeners: [string, EventListener, AddEventListenerOptions | undefined][] = [];

  private attachEvents(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      this.canvas.addEventListener(type, fn as EventListener, options);
      this.listeners.push([type, fn as EventListener, options]);
    };
    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerUp(e));
    on('pointercancel', () => {
      this.drag = null;
      this.delegated = false;
    });
    on('pointerleave', () => {
      if (this.drag || this.delegated) return;
      this.pointer = null;
      this.hoverPending = true;
      this.delegate?.leave?.();
    });
    on('dblclick', (e) => this.delegate?.dblclick?.(e, this.local(e)));
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    on('keydown', (e) => this.onKey(e));
  }

  private detachEvents(): void {
    for (const [type, fn, options] of this.listeners) {
      this.canvas.removeEventListener(type, fn, options);
    }
    this.listeners.length = 0;
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    // Middle-button autoscroll and text selection would fight the navigation.
    if (e.button === 1 || e.button === 0) e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    if (this.delegated) return;
    if (this.drag) {
      // Another button joined a drag (a chord, as FreeCAD uses).
      this.drag.buttons = e.buttons;
      return;
    }
    if (
      this.delegate &&
      e.button === 0 &&
      e.buttons === 1 &&
      !this.cube.contains(this.width, p.x, p.y) &&
      this.delegate.down(e, p)
    ) {
      this.delegated = true;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = {
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      buttons: e.buttons,
      moved: false,
      action: 'none',
      onCube: this.cube.contains(this.width, p.x, p.y),
      panScale: null,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    this.pointer = p;
    if (this.delegated) {
      this.delegate?.move(e, p);
      return;
    }
    const drag = this.drag;
    if (!drag) {
      this.hoverPending = true;
      if (this.delegate && !this.cube.contains(this.width, p.x, p.y)) this.delegate.move(e, p);
      return;
    }
    if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > CLICK_SLOP_PX) drag.moved = true;
    // Until the pointer leaves the click slop, nothing moves; then the whole
    // distance from the press applies, so a drag never loses its first pixels.
    if (!drag.moved) return;
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    drag.x = p.x;
    drag.y = p.y;
    const preset = PRESETS[this.stores.settings.getState().preset];
    const action = dragAction(preset, e.buttons, modifiersOf(e));
    drag.action = action;
    if (action === 'none') return;
    this.transition = null;
    if (action === 'orbit') this.view = orbit(this.view, dx, dy);
    else if (action === 'pan') {
      drag.panScale ??= this.panScaleAt(drag.startX, drag.startY);
      this.view = pan(this.view, dx, dy, this.height, drag.panScale);
    } else {
      const ndc = this.ndc(drag.startX, drag.startY);
      this.view = zoomAt(this.view, ndc, Math.exp(dy * 0.005), this.aspect());
    }
    this.invalidate(true);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.delegated) {
      if (e.button !== 0) return;
      this.delegated = false;
      if (this.canvas.hasPointerCapture(e.pointerId))
        this.canvas.releasePointerCapture(e.pointerId);
      this.delegate?.up(e, this.local(e));
      this.hoverPending = true;
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    if (e.buttons !== 0) {
      drag.buttons = e.buttons;
      return;
    }
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.hoverPending = true;
    if (drag.moved || e.button !== 0) return;
    const p = this.local(e);
    if (drag.onCube) {
      const region = this.cube.regionAt(this.width, p.x, p.y);
      if (region) this.setViewDirection(region.dir);
      return;
    }
    // With a tool in charge, a plain click is the tool's, never a 3D selection.
    if (this.delegate) return;
    const ref = this.pickAt(p.x, p.y);
    this.stores.selection.getState().click(ref, selectModeFor(e));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const preset = PRESETS[this.stores.settings.getState().preset];
    const factor = wheelZoomFactor(preset, wheelDeltaPixels(e.deltaY, e.deltaMode, this.height));
    this.transition = null;
    // Wheels and touchpads send many events per frame, and finding the pivot
    // is a raycast (milliseconds on a large mesh): collect the zoom and apply
    // it once, in the next frame.
    const factorSoFar = this.wheelZoom?.factor ?? 1;
    this.wheelZoom = { x: p.x, y: p.y, factor: factorSoFar * factor };
    this.dirty = true;
  }

  private applyWheelZoom(): void {
    const zoom = this.wheelZoom;
    if (!zoom) return;
    this.wheelZoom = null;
    // Zoom about the model point under the cursor, as Onshape does; off the model,
    // about the point in the target plane.
    const pivot = this.surfacePointAt(zoom.x, zoom.y);
    this.view = pivot
      ? zoomAbout(this.view, pivot, zoom.factor)
      : zoomAt(this.view, this.ndc(zoom.x, zoom.y), zoom.factor, this.aspect());
    this.invalidate(true);
  }

  /** Pan so the model point under the cursor (not the target plane) follows it. */
  private panScaleAt(x: number, y: number): number {
    if (this.stores.settings.getState().projection === 'orthographic') return 1;
    const point = this.surfacePointAt(x, y);
    return point ? panDepthScale(this.view, point, FOV) : 1;
  }

  /** The nearest visible (unclipped) model point under a canvas point. */
  private surfacePointAt(x: number, y: number): Vector3 | null {
    this.updateCameras();
    const ndc = this.ndc(x, y);
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), this.activeCamera());
    const faces = this.bodies.map((b) => b.meshes[2]!);
    for (const hit of this.raycaster.intersectObjects(faces, false)) {
      if (this.clipPlanes.length === 0 || this.clipPlane.distanceToPoint(hit.point) >= 0) {
        return hit.point;
      }
    }
    return null;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'f' || e.key === 'F') this.fitAll();
    else if (e.key === 'Escape' && !this.delegate) this.stores.selection.getState().clear();
  }

  private ndc(x: number, y: number) {
    return { x: (x / this.width) * 2 - 1, y: -((y / this.height) * 2 - 1) };
  }
}

function modifiersOf(e: MouseEvent): Modifiers {
  return { ...NO_MODIFIERS, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
}

/** Colour the vertices `vertices` lists, or all vertices in `[start, end)`. */
function fillColor(
  attr: BufferAttribute,
  vertices: Uint32Array | [number, number],
  color: Color,
): void {
  const a = attr.array as Uint8Array;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const paint = (v: number) => {
    a[v * 3] = r;
    a[v * 3 + 1] = g;
    a[v * 3 + 2] = b;
  };
  if (vertices instanceof Uint32Array) for (const v of vertices) paint(v);
  else for (let v = vertices[0]; v < vertices[1]; v++) paint(v);
}

function appendEdgeSegments(body: ViewBody, edge: number, out: number[]): void {
  for (let s = 0; s < body.segmentEdges.length; s++) {
    if (body.segmentEdges[s] !== edge) continue;
    for (let k = 0; k < 6; k++) out.push(body.segments[s * 6 + k]!);
  }
}

function setSegments(lines: LineSegments2, positions: number[]): void {
  lines.geometry.dispose();
  const g = new LineSegmentsGeometry();
  if (positions.length > 0) g.setPositions(positions);
  lines.geometry = g;
  lines.visible = positions.length > 0;
}

function dotTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  return new CanvasTexture(canvas);
}
