// The joint-coordinate mate solver of ADR 0008.
//
// Unknowns are the mates' free coordinates, not instance poses. The mates, taken in creation
// order, are split into a spanning forest (the oldest mates that connect instance groups,
// rooted at the fixed instances) and loop mates (each closes a cycle of older mates). Poses
// on the forest are exact forward kinematics. Each loop mate adds six closure equations (its
// connectors must meet); loops that share coordinates form one system, solved by
// Levenberg-Marquardt over the coordinates on its loops, seeded from the input poses. DOF,
// redundancy and conflicts come from the rank of each system's Jacobian at the solution.
//
// Units: lengths are millimetres, angles radians. Internally angular coordinates and the
// rotation rows of every residual are scaled by a length L (the size of the assembly), so
// all unknowns and residuals are in millimetres and one tolerance fits both.

import {
  coordinateCount,
  coordinateTwist,
  extractCoordinates,
  isAngular,
  jointTransform,
  limitViolation,
  MATE_KINDS,
  retract,
  type LimitViolation,
} from './mates';
import type {
  AssemblyInput,
  AssemblyIssue,
  AssemblyWarning,
  DragReport,
  DragTarget,
  MateGroup,
  MateKind,
  MateReport,
  Residual,
  SolveReport,
} from './model';
import { rankOf, SvdWorkspace } from './svd';
import {
  applyLeftJacobianInverse,
  copyPose,
  inv,
  mul,
  mulInv,
  normalizeRotation,
  packPose,
  POSE,
  rotateVec,
  rotationLog,
  unpackPose,
  type Pose,
} from './transform';

/** Closure is iterated down to this, relative to L. */
const TOL_CLOSE = 1e-11;
/** A loop left further open than this (relative to L; radians for angles) is a conflict. */
const TOL_CONFLICT = 1e-7;
/** Singular values below this fraction of the largest do not count toward the rank. */
const RANK_TOL = 1e-8;
/** A drag target nearer than this (relative to L) is reached. */
const TOL_REACHED = 1e-7;
const MAX_LM_ITERATIONS = 50;
const MAX_DRAG_ITERATIONS = 30;

interface PreparedMate {
  id: string;
  /** Index in the input's mates (creation order). */
  order: number;
  kind: MateKind;
  ia: number;
  ib: number;
  /** Offset of the first coordinate in the coordinate vector. */
  c0: number;
  nc: number;
  /** Limits, NaN when absent (revolute and slider only). */
  min: number;
  max: number;
}

interface LoopSystem {
  /** Indices into `loops`. */
  loops: number[];
  /** Mates with coordinates that are unknowns here, in column order. */
  mates: number[];
  n: number;
  m: number;
  J: Float64Array;
  r: Float64Array;
  step: Float64Array;
  saved: Float64Array;
  svd: SvdWorkspace;
  rank: number;
  conflicting: boolean;
}

// Scratch space shared by every call (the package is single-threaded per worker).
const T1 = new Float64Array(POSE);
const T2 = new Float64Array(POSE);
const TW = new Float64Array(6);
const V3 = new Float64Array(3);
const PHI = new Float64Array(3);

class Assembly {
  readonly issues: AssemblyIssue[] = [];
  readonly invalidMates = new Map<string, string>();

  // Instances.
  n = 0;
  ids: string[] = [];
  inputPoses: Pose[] = [];
  fixed!: Uint8Array;
  index = new Map<string, number>();
  /** The input poses, normalised and packed. */
  seed!: Float64Array;

  // Mates, valid and unsuppressed, in creation order.
  mates: PreparedMate[] = [];
  CA!: Float64Array; // connector a's frame times the offset
  CAINV!: Float64Array;
  FB!: Float64Array;
  FBINV!: Float64Array;
  coords!: Float64Array;
  /** Per coordinate: L for angles, 1 for lengths. */
  weight!: Float64Array;
  L = 1;
  /** Per mate index: the seed coordinate a tree mate's limits clamped, past which limit. */
  readonly clamped = new Map<number, LimitViolation>();

  // Graph.
  parent: Int32Array;
  parentMate: Int32Array;
  parentIsA: Uint8Array;
  depth: Int32Array;
  order: Int32Array;
  grounded: Uint8Array;
  isTree: Uint8Array;
  rootPose: Float64Array;
  floatingRoots = 0;
  loops: number[] = [];
  pathStart: number[] = [];
  pathMate: number[] = [];
  /** 0: on connector a's side of the loop mate; 1: on b's. */
  pathSide: number[] = [];
  /** +1 when the mate's b side is the child (moving away from the root), else -1. */
  pathSign: number[] = [];
  systems: LoopSystem[] = [];
  /** Per mate: its system, or -1 when its coordinates are on no loop. */
  sysOfMate: Int32Array;
  /** Per mate: the first column of its coordinates in its system. */
  colOf: Int32Array;

  // State.
  W: Float64Array;
  G: Float64Array;
  X: Float64Array;
  XB: Float64Array;
  /** Per loop: position error then rotation vector error (unscaled). */
  loopErr: Float64Array;

  constructor(input: AssemblyInput) {
    this.prepareInstances(input);
    this.prepareMates(input);
    const n = this.n;
    const m = this.mates.length;
    this.parent = new Int32Array(n);
    this.parentMate = new Int32Array(n);
    this.parentIsA = new Uint8Array(n);
    this.depth = new Int32Array(n);
    this.order = new Int32Array(n);
    this.grounded = new Uint8Array(n);
    this.isTree = new Uint8Array(m);
    this.rootPose = new Float64Array(POSE * n);
    this.sysOfMate = new Int32Array(m);
    this.colOf = new Int32Array(m);
    this.W = new Float64Array(POSE * n);
    this.G = new Float64Array(POSE * m);
    this.X = new Float64Array(POSE * m);
    this.XB = new Float64Array(POSE * m);
    this.loopErr = new Float64Array(0);
  }

  private prepareInstances(input: AssemblyInput): void {
    const list = input.instances;
    const seed = new Float64Array(POSE * list.length);
    const fixed = new Uint8Array(list.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const inst of list) {
      if (this.index.has(inst.id)) {
        this.issues.push({
          code: 'duplicate-id',
          instanceId: inst.id,
          message: `Instance id ${inst.id} is used more than once; only the first is solved.`,
        });
        continue;
      }
      const i = this.n++;
      this.index.set(inst.id, i);
      this.ids.push(inst.id);
      this.inputPoses.push(inst.pose);
      fixed[i] = inst.fixed ? 1 : 0;
      if (!packValid(seed, POSE * i, inst.pose)) {
        this.issues.push({
          code: 'invalid-pose',
          instanceId: inst.id,
          message: `Instance ${inst.id} has an invalid pose; it is placed at the origin.`,
        });
        seed.fill(0, POSE * i, POSE * i + 6);
        seed[POSE * i + 6] = 1;
      }
      for (let k = 0; k < 3; k++) {
        const t = seed[POSE * i + k]!;
        lo[k] = Math.min(lo[k]!, t);
        hi[k] = Math.max(hi[k]!, t);
      }
    }
    this.seed = seed;
    this.fixed = fixed;
    if (this.n > 0) {
      this.L = Math.max(this.L, Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!));
    }
  }

  private prepareMates(input: AssemblyInput): void {
    const valid: { mate: (typeof input.mates)[number]; order: number }[] = [];
    const seen = new Set<string>();
    input.mates.forEach((mate, order) => {
      const fail = (code: AssemblyIssue['code'], message: string) => {
        this.issues.push({ code, mateId: mate.id, message });
        this.invalidMates.set(mate.id, message);
      };
      if (seen.has(mate.id)) {
        this.issues.push({
          code: 'duplicate-id',
          mateId: mate.id,
          message: `Mate id ${mate.id} is used more than once; only the first is solved.`,
        });
        return;
      }
      seen.add(mate.id);
      if (mate.suppressed) return;
      if (!MATE_KINDS.includes(mate.kind)) {
        fail('unknown-kind', `Mate ${mate.id} has an unknown kind "${String(mate.kind)}".`);
        return;
      }
      for (const side of [mate.a, mate.b]) {
        if (!this.index.has(side.instance)) {
          fail(
            'unknown-instance',
            `Mate ${mate.id} refers to instance ${side.instance}, which does not exist.`,
          );
          return;
        }
      }
      if (mate.a.instance === mate.b.instance) {
        fail('self-mate', `Mate ${mate.id} connects instance ${mate.a.instance} to itself.`);
        return;
      }
      const t = new Float64Array(POSE);
      if (
        !packValid(t, 0, mate.a.frame) ||
        !packValid(t, 0, mate.b.frame) ||
        (mate.offset !== undefined && !packValid(t, 0, mate.offset))
      ) {
        fail('invalid-pose', `Mate ${mate.id} has an invalid connector frame or offset.`);
        return;
      }
      valid.push({ mate, order });
    });

    const m = valid.length;
    this.CA = new Float64Array(POSE * m);
    this.CAINV = new Float64Array(POSE * m);
    this.FB = new Float64Array(POSE * m);
    this.FBINV = new Float64Array(POSE * m);
    let total = 0;
    let size = this.L;
    valid.forEach(({ mate, order }, j) => {
      const o = POSE * j;
      packValid(this.CA, o, mate.a.frame);
      if (mate.offset) {
        packValid(T1, 0, mate.offset);
        mul(this.CA, o, this.CA, o, T1, 0);
        normalizeRotation(this.CA, o);
      }
      inv(this.CAINV, o, this.CA, o);
      packValid(this.FB, o, mate.b.frame);
      inv(this.FBINV, o, this.FB, o);
      for (const f of [mate.a.frame, mate.b.frame, mate.offset]) {
        if (f) size = Math.max(size, Math.hypot(...f.translation));
      }
      let min = NaN,
        max = NaN;
      if (mate.limits && (mate.kind === 'revolute' || mate.kind === 'slider')) {
        const lmin = mate.limits.min ?? -Infinity;
        const lmax = mate.limits.max ?? Infinity;
        if (Number.isNaN(lmin) || Number.isNaN(lmax) || lmin > lmax) {
          this.issues.push({
            code: 'invalid-limits',
            mateId: mate.id,
            message: `Mate ${mate.id} has limits whose minimum is above the maximum; they are ignored.`,
          });
        } else {
          min = lmin;
          max = lmax;
        }
      }
      const nc = coordinateCount(mate.kind);
      this.mates.push({
        id: mate.id,
        order,
        kind: mate.kind,
        ia: this.index.get(mate.a.instance)!,
        ib: this.index.get(mate.b.instance)!,
        c0: total,
        nc,
        min,
        max,
      });
      total += nc;
    });
    this.L = Math.max(1, size);
    this.coords = new Float64Array(total);
    this.weight = new Float64Array(total);
    for (const mt of this.mates) {
      for (let k = 0; k < mt.nc; k++) this.weight[mt.c0 + k] = isAngular(mt.kind, k) ? this.L : 1;
    }
  }

  /**
   * The spanning forest, its orientation, the loops and the loop systems. `rootOverride`
   * roots its floating group (one not attached to a fixed instance) at that instance.
   */
  buildGraph(rootOverride = -1): void {
    const n = this.n;
    const mates = this.mates;
    const m = mates.length;
    const uf = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) uf[i] = i;
    const find = (x: number): number => {
      while (uf[x] !== x) {
        uf[x] = uf[uf[x]!]!;
        x = uf[x]!;
      }
      return x;
    };
    for (let i = 0; i < n; i++) if (this.fixed[i]) uf[find(i)] = find(n);
    const loops: number[] = [];
    const deg = new Int32Array(n + 1);
    for (let j = 0; j < m; j++) {
      const ra = find(mates[j]!.ia),
        rb = find(mates[j]!.ib);
      if (ra !== rb) {
        uf[ra] = rb;
        this.isTree[j] = 1;
        deg[mates[j]!.ia]!++;
        deg[mates[j]!.ib]!++;
      } else {
        this.isTree[j] = 0;
        loops.push(j);
      }
    }
    // Tree adjacency, CSR, in mate order.
    const adjStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i]! + deg[i]!;
    const fill = adjStart.slice(0, n);
    const adj = new Int32Array(adjStart[n]!);
    for (let j = 0; j < m; j++) {
      if (!this.isTree[j]) continue;
      adj[fill[mates[j]!.ia]!++] = j;
      adj[fill[mates[j]!.ib]!++] = j;
    }
    // Roots: fixed instances, and one per floating group.
    const ground = find(n);
    const compRoot = new Map<number, number>();
    if (rootOverride >= 0 && find(rootOverride) !== ground) {
      compRoot.set(find(rootOverride), rootOverride);
    }
    const parent = this.parent;
    parent.fill(-2);
    let head = 0,
      tail = 0;
    const order = this.order;
    this.floatingRoots = 0;
    for (let i = 0; i < n; i++) {
      const c = find(i);
      let root: boolean;
      if (c === ground) root = this.fixed[i] === 1;
      else {
        if (!compRoot.has(c)) compRoot.set(c, i);
        root = compRoot.get(c) === i;
        if (root) this.floatingRoots++;
      }
      this.grounded[i] = c === ground ? 1 : 0;
      if (root) {
        parent[i] = -1;
        this.parentMate[i] = -1;
        this.depth[i] = 0;
        copyPose(this.rootPose, POSE * i, this.seed, POSE * i);
        order[tail++] = i;
      }
    }
    while (head < tail) {
      const u = order[head++]!;
      for (let e = adjStart[u]!; e < adjStart[u + 1]!; e++) {
        const j = adj[e]!;
        const mt = mates[j]!;
        const v = mt.ia === u ? mt.ib : mt.ia;
        if (parent[v] !== -2) continue;
        parent[v] = u;
        this.parentMate[v] = j;
        this.parentIsA[v] = mt.ia === u ? 1 : 0;
        this.depth[v] = this.depth[u]! + 1;
        order[tail++] = v;
      }
    }

    // Loop paths: the tree mates from each end of a loop mate up to where the ends meet.
    this.loops = loops;
    this.pathStart = [];
    this.pathMate = [];
    this.pathSide = [];
    this.pathSign = [];
    const push = (j: number, side: number, sign: number) => {
      this.pathMate.push(j);
      this.pathSide.push(side);
      this.pathSign.push(sign);
    };
    for (const l of loops) {
      this.pathStart.push(this.pathMate.length);
      const mt = mates[l]!;
      push(l, 0, 1); // the loop mate's own coordinates move connector a's frame X
      let u = mt.ia,
        v = mt.ib;
      const up = (w: number, side: number) => {
        push(this.parentMate[w]!, side, this.parentIsA[w] ? 1 : -1);
        return parent[w]!;
      };
      while (this.depth[u]! > this.depth[v]!) u = up(u, 0);
      while (this.depth[v]! > this.depth[u]!) v = up(v, 1);
      while (u !== v && parent[u] !== -1) {
        u = up(u, 0);
        v = up(v, 1);
      }
    }
    this.pathStart.push(this.pathMate.length);
    this.loopErr = new Float64Array(6 * loops.length);

    // Systems: loops sharing a coordinate-bearing mate are solved together.
    const L = loops.length;
    const luf = new Int32Array(L);
    for (let i = 0; i < L; i++) luf[i] = i;
    const lfind = (x: number): number => {
      while (luf[x] !== x) {
        luf[x] = luf[luf[x]!]!;
        x = luf[x]!;
      }
      return x;
    };
    const owner = new Int32Array(m).fill(-1);
    for (let li = 0; li < L; li++) {
      for (let e = this.pathStart[li]!; e < this.pathStart[li + 1]!; e++) {
        const j = this.pathMate[e]!;
        if (mates[j]!.nc === 0) continue;
        if (owner[j]! < 0) owner[j] = li;
        else luf[lfind(li)] = lfind(owner[j]!);
      }
    }
    this.systems = [];
    this.sysOfMate.fill(-1);
    const sysOfRoot = new Map<number, LoopSystem>();
    for (let li = 0; li < L; li++) {
      const r = lfind(li);
      let sys = sysOfRoot.get(r);
      if (!sys) {
        sys = {
          loops: [],
          mates: [],
          n: 0,
          m: 0,
          J: new Float64Array(0),
          r: new Float64Array(0),
          step: new Float64Array(0),
          saved: new Float64Array(0),
          svd: new SvdWorkspace(),
          rank: 0,
          conflicting: false,
        };
        sysOfRoot.set(r, sys);
        this.systems.push(sys);
      }
      sys.loops.push(li);
    }
    this.systems.forEach((sys, s) => {
      for (const li of sys.loops) {
        for (let e = this.pathStart[li]!; e < this.pathStart[li + 1]!; e++) {
          const j = this.pathMate[e]!;
          if (mates[j]!.nc === 0 || this.sysOfMate[j] === s) continue;
          this.sysOfMate[j] = s;
          this.colOf[j] = sys.n;
          sys.n += mates[j]!.nc;
          sys.mates.push(j);
        }
      }
      sys.m = 6 * sys.loops.length;
      sys.J = new Float64Array(sys.m * sys.n);
      sys.r = new Float64Array(sys.m);
      sys.step = new Float64Array(sys.n);
      sys.saved = new Float64Array(sys.n);
    });
  }

  /** Coordinates from the input poses; tree coordinates on no loop are clamped to limits. */
  extractCoordinates(): void {
    const seed = this.seed;
    for (let j = 0; j < this.mates.length; j++) {
      const mt = this.mates[j]!;
      if (mt.nc === 0) continue;
      // rel = (W_a CA)^-1 (W_b FB).
      mul(T1, 0, seed, POSE * mt.ia, this.CA, POSE * j);
      mul(T2, 0, seed, POSE * mt.ib, this.FB, POSE * j);
      mulInv(T2, 0, T1, 0, T2, 0);
      extractCoordinates(mt.kind, T2, 0, this.coords, mt.c0);
      if (!Number.isNaN(mt.min)) {
        const c = mt.c0;
        if (mt.kind === 'revolute') this.coords[c] = nearestTurn(this.coords[c]!, mt.min, mt.max);
        if (this.sysOfMate[j]! < 0) {
          const past = limitViolation(this.coords[c]!, mt, this.limitTolerance(mt.kind));
          if (past !== null) this.clamped.set(j, past);
          this.coords[c] = clamp(this.coords[c]!, mt.min, mt.max);
        }
      }
    }
  }

  /** How far past a limit a coordinate may be before it counts: rounding, not a real excess. */
  limitTolerance(kind: MateKind): number {
    return kind === 'revolute' ? 1e-9 : 1e-9 * this.L;
  }

  /** Forward kinematics: every pose from the roots and the coordinates, then loop errors. */
  forward(): void {
    const W = this.W,
      G = this.G,
      X = this.X;
    const order = this.order;
    for (let k = 0; k < this.n; k++) {
      const i = order[k]!;
      const oi = POSE * i;
      const p = this.parent[i]!;
      if (p === -1) {
        copyPose(W, oi, this.rootPose, oi);
        continue;
      }
      const j = this.parentMate[i]!;
      const mt = this.mates[j]!;
      const oj = POSE * j;
      jointTransform(mt.kind, this.coords, mt.c0, T1, 0);
      if (this.parentIsA[i]) {
        mul(G, oj, W, POSE * p, this.CA, oj);
        mul(X, oj, G, oj, T1, 0);
        mul(W, oi, X, oj, this.FBINV, oj);
      } else {
        mul(X, oj, W, POSE * p, this.FB, oj);
        inv(T1, 0, T1, 0);
        mul(G, oj, X, oj, T1, 0);
        mul(W, oi, G, oj, this.CAINV, oj);
      }
      // Keep long chains unit length.
      if ((k & 15) === 0) normalizeRotation(W, oi);
    }
    for (let li = 0; li < this.loops.length; li++) this.loopError(li);
  }

  /** Frames of loop mate li and its error: XB - X (position) and log(R_XB R_X^T). */
  private loopError(li: number): void {
    const j = this.loops[li]!;
    const mt = this.mates[j]!;
    const oj = POSE * j;
    const G = this.G,
      X = this.X,
      XB = this.XB;
    mul(G, oj, this.W, POSE * mt.ia, this.CA, oj);
    jointTransform(mt.kind, this.coords, mt.c0, T1, 0);
    mul(X, oj, G, oj, T1, 0);
    mul(XB, oj, this.W, POSE * mt.ib, this.FB, oj);
    const e = this.loopErr;
    const o = 6 * li;
    e[o] = XB[oj]! - X[oj]!;
    e[o + 1] = XB[oj + 1]! - X[oj + 1]!;
    e[o + 2] = XB[oj + 2]! - X[oj + 2]!;
    relativeRotation(T2, XB, oj, X, oj);
    rotationLog(e, o + 3, T2, 0);
  }

  /** Scaled residual of the system into sys.r; returns its squared norm. */
  private systemResidual(sys: LoopSystem): number {
    const L = this.L;
    let cost = 0;
    sys.loops.forEach((li, b) => {
      for (let k = 0; k < 6; k++) {
        const v = this.loopErr[6 * li + k]! * (k < 3 ? 1 : L);
        sys.r[6 * b + k] = v;
        cost += v * v;
      }
    });
    return cost;
  }

  /** The system's scaled Jacobian (column-major) at the current state into sys.J. */
  private systemJacobian(sys: LoopSystem, J = sys.J, colOf = this.colOf, rows = sys.m): void {
    J.fill(0);
    sys.loops.forEach((li, b) => this.loopRows(li, 6 * b, J, rows, colOf, (j) => j >= 0));
  }

  /**
   * Adds loop li's six rows, starting at `row`, into the column-major matrix J with `rows`
   * rows, using column map colOf for the mates `use` accepts.
   */
  private loopRows(
    li: number,
    row: number,
    J: Float64Array,
    rows: number,
    colOf: Int32Array,
    use: (col: number, j: number) => boolean,
  ): void {
    const L = this.L;
    const j0 = this.loops[li]!;
    const oj = POSE * j0;
    const e = this.loopErr;
    const px = e[6 * li + 3]!,
      py = e[6 * li + 4]!,
      pz = e[6 * li + 5]!;
    for (let p = this.pathStart[li]!; p < this.pathStart[li + 1]!; p++) {
      const j = this.pathMate[p]!;
      const mt = this.mates[j]!;
      if (mt.nc === 0) continue;
      const col0 = colOf[j]!;
      if (!use(col0, j)) continue;
      const sideB = this.pathSide[p] === 1;
      const coef = sideB ? this.pathSign[p]! : -this.pathSign[p]!;
      const T = sideB ? this.XB : this.X;
      const tx = T[oj]!,
        ty = T[oj + 1]!,
        tz = T[oj + 2]!;
      for (let k = 0; k < mt.nc; k++) {
        coordinateTwist(mt.kind, k, this.G, POSE * j, this.X, POSE * j, TW, 0);
        const wx = TW[0]!,
          wy = TW[1]!,
          wz = TW[2]!;
        const f = coef / this.weight[mt.c0 + k]!;
        const c = (col0 + k) * rows + row;
        J[c] = J[c]! + f * (wy * tz - wz * ty + TW[3]!);
        J[c + 1] = J[c + 1]! + f * (wz * tx - wx * tz + TW[4]!);
        J[c + 2] = J[c + 2]! + f * (wx * ty - wy * tx + TW[5]!);
        if (sideB) applyLeftJacobianInverse(V3, 0, px, py, pz, wx, wy, wz);
        else applyLeftJacobianInverse(V3, 0, -px, -py, -pz, wx, wy, wz);
        J[c + 3] = J[c + 3]! + f * L * V3[0]!;
        J[c + 4] = J[c + 4]! + f * L * V3[1]!;
        J[c + 5] = J[c + 5]! + f * L * V3[2]!;
      }
    }
  }

  private saveCoords(mates: readonly number[], buf: Float64Array): void {
    let c = 0;
    for (const j of mates) {
      const mt = this.mates[j]!;
      for (let k = 0; k < mt.nc; k++) buf[c++] = this.coords[mt.c0 + k]!;
    }
  }

  private restoreCoords(mates: readonly number[], buf: Float64Array): void {
    let c = 0;
    for (const j of mates) {
      const mt = this.mates[j]!;
      for (let k = 0; k < mt.nc; k++) this.coords[mt.c0 + k] = buf[c++]!;
    }
  }

  /** Applies a scaled step (columns in `mates` order) to the coordinates. */
  private applyStep(mates: readonly number[], step: Float64Array): void {
    let c = 0;
    for (const j of mates) {
      const mt = this.mates[j]!;
      for (let k = 0; k < mt.nc; k++) STEPQ[k] = step[c + k]! / this.weight[mt.c0 + k]!;
      retract(mt.kind, this.coords, mt.c0, STEPQ, 0);
      c += mt.nc;
    }
  }

  /** Levenberg-Marquardt on one system's closures. Returns the final squared residual. */
  closeSystem(sys: LoopSystem, maxIterations = MAX_LM_ITERATIONS): number {
    this.forward();
    let cost = this.systemResidual(sys);
    const goal = (TOL_CLOSE * this.L) ** 2;
    if (sys.n === 0) return cost;
    let lambda = 0;
    for (let it = 0; it < maxIterations && cost > goal; it++) {
      this.systemJacobian(sys);
      const k = sys.svd.decompose(sys.J, sys.m, sys.n);
      const smax = maxOf(sys.svd.s, k);
      if (!(smax > 0)) break;
      this.saveCoords(sys.mates, sys.saved);
      let accepted = false;
      let stepNorm = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        stepNorm = dampedStep(sys.svd, sys.m, sys.n, sys.r, lambda, smax, sys.step);
        const predicted = PREDICTED.value;
        this.applyStep(sys.mates, sys.step);
        this.forward();
        const next = this.systemResidual(sys);
        if (next < cost) {
          const rho = (cost - next) / Math.max(predicted, 1e-300);
          if (rho > 0.75) lambda = lambda < 1e-10 * smax * smax ? 0 : lambda / 3;
          else if (rho < 0.25) lambda = Math.max(lambda * 4, 1e-8 * smax * smax);
          cost = next;
          accepted = true;
          break;
        }
        this.restoreCoords(sys.mates, sys.saved);
        lambda = Math.max(lambda * 10, 1e-8 * smax * smax);
      }
      if (!accepted) {
        this.forward();
        this.systemResidual(sys);
        break;
      }
      if (stepNorm < 1e-14 * this.L) break;
    }
    return cost;
  }

  closeAll(): void {
    for (const sys of this.systems) this.closeSystem(sys);
    this.forward();
  }

  /** Rank, conflicts and redundancy per system at the current state. */
  analyze(): { redundant: MateGroup[]; conflicting: MateGroup[]; redundantMates: Set<number> } {
    const redundant: MateGroup[] = [];
    const conflicting: MateGroup[] = [];
    const redundantMates = new Set<number>();
    const L = this.L;
    for (const sys of this.systems) {
      sys.conflicting = false;
      const open: number[] = [];
      for (const li of sys.loops) {
        const { position, angle } = this.loopResidual(li);
        if (position > TOL_CONFLICT * L || angle > TOL_CONFLICT) open.push(li);
      }
      if (open.length > 0) {
        sys.conflicting = true;
        for (const li of open) {
          const group = this.loopGroup(li);
          const { position, angle } = this.loopResidual(li);
          conflicting.push({
            ...group,
            message:
              `${listMates(group.mates, 'Mate', 'Mates')} ${group.mates.length === 1 ? 'does' : 'do'} ` +
              `not close: the connectors of ${group.blame} stay ${describeGap(position, angle)} apart. ` +
              `Change or remove ${group.blame}, the newest of them.`,
          });
        }
        continue;
      }
      if (sys.n === 0) {
        sys.rank = 0;
      } else {
        this.systemJacobian(sys);
        sys.svd.decompose(sys.J, sys.m, sys.n);
        sys.rank = rankOf(sys.svd, RANK_TOL);
      }
      for (let b = 0; b < sys.loops.length; b++) {
        const li = sys.loops[b]!;
        const j = this.loops[li]!;
        const nl = this.mates[j]!.nc;
        let without = 0;
        if (sys.loops.length > 1 && sys.n - nl > 0) {
          // The system without this loop's rows and its loop mate's columns.
          const colOf = new Int32Array(this.mates.length).fill(-1);
          let n2 = 0;
          for (const jj of sys.mates) {
            if (jj === j) continue;
            colOf[jj] = n2;
            n2 += this.mates[jj]!.nc;
          }
          const rows = 6 * (sys.loops.length - 1);
          const J2 = new Float64Array(rows * n2);
          let row = 0;
          for (const lj of sys.loops) {
            if (lj === li) continue;
            this.loopRows(lj, row, J2, rows, colOf, (c) => c >= 0);
            row += 6;
          }
          const ws = new SvdWorkspace();
          ws.decompose(J2, rows, n2);
          without = rankOf(ws, RANK_TOL);
        }
        if (sys.rank - without - nl <= 0) {
          const group = this.loopGroup(li);
          redundantMates.add(j);
          const others = group.mates.filter((id) => id !== group.blame);
          redundant.push({
            ...group,
            message:
              `Mate ${group.blame} is redundant: ${listMates(others, 'mate', 'mates')} already ` +
              `${others.length === 1 ? 'holds' : 'hold'} everything it holds. Remove it, or ` +
              `change it so that it holds something new.`,
          });
        }
      }
    }
    return { redundant, conflicting, redundantMates };
  }

  loopResidual(li: number): Residual {
    const e = this.loopErr;
    const o = 6 * li;
    return {
      position: Math.hypot(e[o]!, e[o + 1]!, e[o + 2]!),
      angle: Math.hypot(e[o + 3]!, e[o + 4]!, e[o + 5]!),
    };
  }

  /** The mates of loop li in creation order; the loop mate (the newest) is blamed. */
  private loopGroup(li: number): { mates: string[]; blame: string } {
    const set = new Set<number>();
    for (let p = this.pathStart[li]!; p < this.pathStart[li + 1]!; p++) set.add(this.pathMate[p]!);
    const list = [...set].sort((a, b) => this.mates[a]!.order - this.mates[b]!.order);
    return {
      mates: list.map((j) => this.mates[j]!.id),
      blame: this.mates[this.loops[li]!]!.id,
    };
  }

  // Drags ------------------------------------------------------------------

  /**
   * Moves the free coordinates between the dragged instance and its fixed root (and the loops
   * they close) toward the target, keeping loops closed. Returns nothing; the state is left
   * at the result.
   */
  dragGrounded(d: number, target: DragTarget): void {
    // Path from the dragged instance to its root, with the direction each mate moves it.
    const pathMates: number[] = [];
    const pathSigns: number[] = [];
    for (let u = d; this.parent[u]! >= 0; u = this.parent[u]!) {
      const j = this.parentMate[u]!;
      if (this.mates[j]!.nc === 0) continue;
      pathMates.push(j);
      pathSigns.push(this.parentIsA[u] ? 1 : -1);
    }
    if (pathMates.length === 0) return;
    // Unknowns: the path's coordinates and those of every loop system they belong to.
    const coupled: LoopSystem[] = [];
    for (const j of pathMates) {
      const s = this.sysOfMate[j]!;
      if (s >= 0 && !coupled.includes(this.systems[s]!)) coupled.push(this.systems[s]!);
    }
    const unknowns: number[] = [...pathMates];
    for (const sys of coupled)
      for (const j of sys.mates) if (!unknowns.includes(j)) unknowns.push(j);
    const col = new Int32Array(this.mates.length).fill(-1);
    let n = 0;
    for (const j of unknowns) {
      col[j] = n;
      n += this.mates[j]!.nc;
    }
    const loopList: number[] = [];
    for (const sys of coupled) loopList.push(...sys.loops);
    const ml = 6 * loopList.length;
    const pointTarget = 'point' in target;
    const nd = pointTarget ? 3 : 6;
    const Jl = new Float64Array(ml * n);
    const rl = new Float64Array(ml);
    const Jd = new Float64Array(nd * n);
    const rd = new Float64Array(nd);
    const M = new Float64Array(nd * n);
    const step = new Float64Array(n);
    const dp = new Float64Array(n);
    const saved = new Float64Array(n);
    const frozen = new Uint8Array(n);
    const svd = new SvdWorkspace();
    const A = new Float64Array(nd * nd);
    const y = new Float64Array(nd);
    const tgt = new Float64Array(POSE);
    let localPoint: readonly number[] = [0, 0, 0];
    if (pointTarget) {
      localPoint = target.point;
      tgt[0] = target.position[0];
      tgt[1] = target.position[1];
      tgt[2] = target.position[2];
    } else {
      packPose(tgt, 0, target);
      normalizeRotation(tgt, 0);
    }
    const L = this.L;
    const inLoop = (j: number) => this.sysOfMate[j]! >= 0;

    const dragResidual = (): number => {
      const od = POSE * d;
      if (pointTarget) {
        rotateVec(V3, 0, this.W, od, localPoint[0]!, localPoint[1]!, localPoint[2]!);
        rd[0] = V3[0]! + this.W[od]! - tgt[0]!;
        rd[1] = V3[1]! + this.W[od + 1]! - tgt[1]!;
        rd[2] = V3[2]! + this.W[od + 2]! - tgt[2]!;
      } else {
        rd[0] = this.W[od]! - tgt[0]!;
        rd[1] = this.W[od + 1]! - tgt[1]!;
        rd[2] = this.W[od + 2]! - tgt[2]!;
        relativeRotation(T2, this.W, od, tgt, 0);
        rotationLog(PHI, 0, T2, 0);
        rd[3] = L * PHI[0]!;
        rd[4] = L * PHI[1]!;
        rd[5] = L * PHI[2]!;
      }
      let c = 0;
      for (let k = 0; k < nd; k++) c += rd[k]! * rd[k]!;
      return c;
    };

    const dragJacobian = () => {
      Jd.fill(0);
      const od = POSE * d;
      let px = this.W[od]!,
        py = this.W[od + 1]!,
        pz = this.W[od + 2]!;
      if (pointTarget) {
        px = rd[0]! + tgt[0]!;
        py = rd[1]! + tgt[1]!;
        pz = rd[2]! + tgt[2]!;
      }
      pathMates.forEach((j, idx) => {
        const mt = this.mates[j]!;
        for (let k = 0; k < mt.nc; k++) {
          const cc = col[j]! + k;
          if (frozen[cc]) continue;
          coordinateTwist(mt.kind, k, this.G, POSE * j, this.X, POSE * j, TW, 0);
          const f = pathSigns[idx]! / this.weight[mt.c0 + k]!;
          const wx = TW[0]!,
            wy = TW[1]!,
            wz = TW[2]!;
          const o = cc * nd;
          Jd[o] = f * (wy * pz - wz * py + TW[3]!);
          Jd[o + 1] = f * (wz * px - wx * pz + TW[4]!);
          Jd[o + 2] = f * (wx * py - wy * px + TW[5]!);
          if (!pointTarget) {
            applyLeftJacobianInverse(V3, 0, PHI[0]!, PHI[1]!, PHI[2]!, wx, wy, wz);
            Jd[o + 3] = f * L * V3[0]!;
            Jd[o + 4] = f * L * V3[1]!;
            Jd[o + 5] = f * L * V3[2]!;
          }
        }
      });
    };

    const closeCoupled = (): boolean => {
      let ok = true;
      for (const sys of coupled) {
        const c = this.closeSystem(sys, 12);
        if (c > (TOL_CONFLICT * L) ** 2) ok = false;
      }
      if (coupled.length === 0) this.forward();
      return ok;
    };

    this.forward();
    let cost = dragResidual();
    let mu = 1e-6;
    let rejects = 0;
    for (let it = 0; it < MAX_DRAG_ITERATIONS; it++) {
      if (Math.sqrt(cost) <= TOL_REACHED * 1e-2 * L) break;
      // Loop rows (they are closed now, so their residual is only what closure left).
      Jl.fill(0);
      loopList.forEach((li, b) => {
        this.loopRows(li, 6 * b, Jl, ml, col, (c) => c >= 0 && !frozen[c]);
        for (let k = 0; k < 6; k++) rl[6 * b + k] = this.loopErr[6 * li + k]! * (k < 3 ? 1 : L);
      });
      dragJacobian();
      // Particular step closing the loops, and the projector onto their null space.
      dp.fill(0);
      let rank = 0;
      let kk = 0;
      let smax = 0;
      if (ml > 0) {
        kk = svd.decompose(Jl, ml, n);
        smax = maxOf(svd.s, kk);
        for (let i = 0; i < kk; i++) {
          const s = svd.s[i]!;
          if (!(s > RANK_TOL * smax) || !(smax > 1e-12)) continue;
          rank++;
          let ur = 0;
          for (let r = 0; r < ml; r++) ur += svd.u[i * ml + r]! * rl[r]!;
          const f = -ur / s;
          for (let c = 0; c < n; c++) dp[c] = dp[c]! + f * svd.v[i * n + c]!;
        }
      }
      // M = Jd (I - Vr Vr^T).
      M.set(Jd);
      if (rank > 0) {
        for (let i = 0; i < kk; i++) {
          if (!(svd.s[i]! > RANK_TOL * smax)) continue;
          for (let r = 0; r < nd; r++) {
            let jv = 0;
            for (let c = 0; c < n; c++) jv += Jd[c * nd + r]! * svd.v[i * n + c]!;
            for (let c = 0; c < n; c++) M[c * nd + r] = M[c * nd + r]! - jv * svd.v[i * n + c]!;
          }
        }
      }
      for (let c = 0; c < n; c++) if (frozen[c]) for (let r = 0; r < nd; r++) M[c * nd + r] = 0;
      // Damped least squares on the drag rows: z = -M^T (M M^T + mu tr I)^-1 (rd + Jd dp).
      let trace = 0;
      for (let r = 0; r < nd; r++) {
        for (let q = 0; q < nd; q++) {
          let s = 0;
          for (let c = 0; c < n; c++) s += M[c * nd + r]! * M[c * nd + q]!;
          A[r + q * nd] = s;
        }
        trace += A[r + r * nd]!;
        let s = rd[r]!;
        for (let c = 0; c < n; c++) s += Jd[c * nd + r]! * dp[c]!;
        y[r] = s;
      }
      if (!(trace > 1e-24)) break;
      this.saveCoords(unknowns, saved);
      let accepted = false;
      let stepNorm = 0;
      const A0 = A.slice();
      const y0 = y.slice();
      for (; rejects < 12;) {
        A.set(A0);
        y.set(y0);
        const damp = (mu * trace) / nd + 1e-18;
        for (let r = 0; r < nd; r++) A[r + r * nd] = A[r + r * nd]! + damp;
        solveSymmetric(A, y, nd);
        stepNorm = 0;
        for (let c = 0; c < n; c++) {
          let s = 0;
          for (let r = 0; r < nd; r++) s += M[c * nd + r]! * y[r]!;
          step[c] = frozen[c] ? 0 : dp[c]! - s;
          stepNorm += step[c]! * step[c]!;
        }
        stepNorm = Math.sqrt(stepNorm);
        // What the linear model predicts the drag residual falls to.
        let predicted = 0;
        for (let r = 0; r < nd; r++) {
          let s = rd[r]!;
          for (let c = 0; c < n; c++) s += Jd[c * nd + r]! * step[c]!;
          predicted += s * s;
        }
        this.applyStep(unknowns, step);
        // Limits clamp tree coordinates; the ones pushed against a limit freeze.
        for (const j of unknowns) {
          const mt = this.mates[j]!;
          if (Number.isNaN(mt.min) || inLoop(j)) continue;
          const c = mt.c0;
          if (this.coords[c]! < mt.min || this.coords[c]! > mt.max) {
            this.coords[c] = clamp(this.coords[c]!, mt.min, mt.max);
            frozen[col[j]!] = 1;
          }
        }
        const closed = closeCoupled();
        const next = dragResidual();
        if (closed && next < cost) {
          // Gain ratio: far from the linear model (a large residual, curvature) means damp more.
          const rho = (cost - next) / Math.max(cost - predicted, 1e-300);
          if (rho > 0.75) mu = Math.max(mu / 3, 1e-9);
          else if (rho < 0.25) mu *= 4;
          cost = next;
          accepted = true;
          break;
        }
        this.restoreCoords(unknowns, saved);
        rejects++;
        mu *= 10;
      }
      if (!accepted) {
        closeCoupled();
        dragResidual();
        break;
      }
      rejects = 0;
      if (stepNorm < 1e-12 * L) break;
    }
  }

  /** Rigidly moves a floating group, rooted at the dragged instance, to the target. */
  dragFloating(d: number, target: DragTarget): void {
    const o = POSE * d;
    if ('point' in target) {
      this.forward();
      rotateVec(V3, 0, this.W, o, target.point[0], target.point[1], target.point[2]);
      for (let k = 0; k < 3; k++) {
        this.rootPose[o + k] =
          this.rootPose[o + k]! + target.position[k]! - V3[k]! - this.W[o + k]!;
      }
    } else {
      packPose(this.rootPose, o, target);
      normalizeRotation(this.rootPose, o);
    }
    this.closeAll();
  }

  /** How far the dragged instance is from the target. */
  targetResidual(d: number, target: DragTarget): Residual {
    const o = POSE * d;
    if ('point' in target) {
      rotateVec(V3, 0, this.W, o, target.point[0], target.point[1], target.point[2]);
      return {
        position: Math.hypot(
          V3[0]! + this.W[o]! - target.position[0],
          V3[1]! + this.W[o + 1]! - target.position[1],
          V3[2]! + this.W[o + 2]! - target.position[2],
        ),
        angle: 0,
      };
    }
    packPose(T1, 0, target);
    normalizeRotation(T1, 0);
    relativeRotation(T2, this.W, o, T1, 0);
    rotationLog(PHI, 0, T2, 0);
    return {
      position: Math.hypot(this.W[o]! - T1[0]!, this.W[o + 1]! - T1[1]!, this.W[o + 2]! - T1[2]!),
      angle: Math.hypot(PHI[0]!, PHI[1]!, PHI[2]!),
    };
  }

  // Report -----------------------------------------------------------------

  report(input: AssemblyInput, warnings: AssemblyWarning[]): SolveReport {
    const { redundant, conflicting, redundantMates } = this.analyze();
    const poses: Record<string, Pose> = {};
    for (let i = 0; i < this.n; i++) {
      poses[this.ids[i]!] = this.outputPose(i);
    }
    const conflictingIds = new Set<string>();
    for (const g of conflicting) for (const id of g.mates) conflictingIds.add(id);
    const loopOf = new Map<number, number>();
    this.loops.forEach((j, li) => loopOf.set(j, li));
    const byId = new Map<string, number>();
    this.mates.forEach((mt, j) => byId.set(mt.id, j));
    const mates: Record<string, MateReport> = {};
    const zero: Residual = { position: 0, angle: 0 };
    const seen = new Set<string>();
    for (const mate of input.mates) {
      if (seen.has(mate.id)) continue;
      seen.add(mate.id);
      const invalid = this.invalidMates.get(mate.id);
      if (invalid !== undefined) {
        mates[mate.id] = { status: 'invalid', coordinates: [], residual: zero, message: invalid };
        continue;
      }
      const j = byId.get(mate.id);
      if (j === undefined) {
        mates[mate.id] = {
          status: 'suppressed',
          coordinates: [],
          residual: zero,
          message: `Mate ${mate.id} is suppressed.`,
        };
        continue;
      }
      const mt = this.mates[j]!;
      const li = loopOf.get(j);
      const residual = li === undefined ? zero : this.loopResidual(li);
      const coordinates = Array.from(this.coords.subarray(mt.c0, mt.c0 + mt.nc));
      const entry: MateReport = { status: 'ok', coordinates, residual };
      if (conflictingIds.has(mt.id)) {
        entry.status = 'conflicting';
        entry.message = conflicting.find((g) => g.mates.includes(mt.id))!.message;
      } else if (redundantMates.has(j)) {
        entry.status = 'redundant';
        entry.message = redundant.find((g) => g.blame === mt.id)!.message;
      }
      mates[mate.id] = entry;
      // The stored poses put a tree mate past a limit: it was clamped there, say so.
      const clamped = this.clamped.get(j);
      if (clamped !== undefined) {
        const side = clamped.bound === 'max' ? 'maximum' : 'minimum';
        warnings.push({
          code: 'clamped',
          mateId: mt.id,
          ...clamped,
          message: `Mate ${mt.id} was at ${formatCoordinate(mt.kind, clamped.value)}, past its ${side} of ${formatCoordinate(mt.kind, clamped.limit)}: it is held at the limit, so the instances on it are not where their stored poses put them.`,
        });
      }
      // Limits are not enforced inside loops: say so when a loop leaves one.
      if (!Number.isNaN(mt.min) && this.sysOfMate[j]! >= 0) {
        const past = limitViolation(this.coords[mt.c0]!, mt, this.limitTolerance(mt.kind));
        if (past !== null) {
          warnings.push({
            code: 'outside-limits',
            mateId: mt.id,
            ...past,
            message: `Mate ${mt.id} is outside its limits (${formatCoordinate(mt.kind, past.value)}); limits are not enforced inside loops of mates.`,
          });
        }
      }
    }
    let dof: number | null = null;
    if (conflicting.length === 0) {
      dof = 6 * this.floatingRoots + this.coords.length;
      for (const sys of this.systems) dof -= sys.rank;
    }
    const outcome =
      this.issues.length > 0 ? 'invalid' : conflicting.length > 0 ? 'conflicting' : 'solved';
    const parts: string[] = [];
    if (this.issues.length > 0) {
      parts.push(
        `${plural(this.issues.length, 'input problem', 'input problems')}: ${this.issues[0]!.message}`,
      );
    }
    if (conflicting.length > 0) parts.push(conflicting[0]!.message);
    if (redundant.length > 0) parts.push(redundant[0]!.message);
    const report: SolveReport = {
      outcome,
      poses,
      dof,
      redundant,
      conflicting,
      mates,
      issues: this.issues,
      warnings,
    };
    if (parts.length > 0) report.message = parts.join(' ');
    return report;
  }

  /** The solved pose of instance i, or its input pose when it did not move. */
  private outputPose(i: number): Pose {
    const o = POSE * i;
    const W = this.W,
      S = this.seed;
    normalizeRotation(W, o);
    const dot =
      W[o + 3]! * S[o + 3]! + W[o + 4]! * S[o + 4]! + W[o + 5]! * S[o + 5]! + W[o + 6]! * S[o + 6]!;
    const moved =
      Math.abs(W[o]! - S[o]!) > 1e-12 * this.L ||
      Math.abs(W[o + 1]! - S[o + 1]!) > 1e-12 * this.L ||
      Math.abs(W[o + 2]! - S[o + 2]!) > 1e-12 * this.L ||
      Math.abs(dot) < 1 - 1e-15;
    if (!moved) return this.inputPoses[i]!;
    if (dot < 0) for (let k = 3; k < 7; k++) W[o + k] = -W[o + k]!;
    return unpackPose(W, o);
  }
}

const STEPQ = new Float64Array(3);

// Numerics helpers -----------------------------------------------------------

/** The reduction of the squared residual the linear model predicts for the last dampedStep. */
const PREDICTED = { value: 0 };

/**
 * step = -sum_i v_i s_i / (s_i^2 + lambda) (u_i . r), skipping negligible s_i. Leaves the
 * predicted reduction |r|^2 - |r + J step|^2 in PREDICTED.
 */
function dampedStep(
  svd: SvdWorkspace,
  m: number,
  n: number,
  r: Float64Array,
  lambda: number,
  smax: number,
  step: Float64Array,
): number {
  step.fill(0, 0, n);
  let predicted = 0;
  for (let i = 0; i < svd.k; i++) {
    const s = svd.s[i]!;
    if (!(s > 1e-10 * smax)) continue;
    let ur = 0;
    for (let q = 0; q < m; q++) ur += svd.u[i * m + q]! * r[q]!;
    const f = (-s * ur) / (s * s + lambda);
    const keep = lambda / (s * s + lambda);
    predicted += ur * ur * (1 - keep * keep);
    for (let c = 0; c < n; c++) step[c] = step[c]! + f * svd.v[i * n + c]!;
  }
  PREDICTED.value = predicted;
  let norm = 0;
  for (let c = 0; c < n; c++) norm += step[c]! * step[c]!;
  return Math.sqrt(norm);
}

/** Solves A x = b in place (b becomes x) for a small symmetric positive definite A. */
function solveSymmetric(A: Float64Array, b: Float64Array, n: number): void {
  // Cholesky, column-major lower triangle.
  for (let j = 0; j < n; j++) {
    let d = A[j + j * n]!;
    for (let k = 0; k < j; k++) d -= A[j + k * n]! ** 2;
    d = Math.sqrt(Math.max(d, 1e-300));
    A[j + j * n] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i + j * n]!;
      for (let k = 0; k < j; k++) s -= A[i + k * n]! * A[j + k * n]!;
      A[i + j * n] = s / d;
    }
  }
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= A[i + k * n]! * b[k]!;
    b[i] = s / A[i + i * n]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < n; k++) s -= A[k + i * n]! * b[k]!;
    b[i] = s / A[i + i * n]!;
  }
}

function maxOf(a: Float64Array, k: number): number {
  let m = 0;
  for (let i = 0; i < k; i++) if (a[i]! > m) m = a[i]!;
  return m;
}

/** out rotation = R_a R_b^T (translation part left untouched). */
function relativeRotation(
  out: Float64Array,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  const ax = a[ao + 3]!,
    ay = a[ao + 4]!,
    az = a[ao + 5]!,
    aw = a[ao + 6]!;
  const bx = -b[bo + 3]!,
    by = -b[bo + 4]!,
    bz = -b[bo + 5]!,
    bw = b[bo + 6]!;
  out[3] = aw * bx + ax * bw + ay * bz - az * by;
  out[4] = aw * by - ax * bz + ay * bw + az * bx;
  out[5] = aw * bz + ax * by - ay * bx + az * bw;
  out[6] = aw * bw - ax * bx - ay * by - az * bz;
}

function packValid(out: Float64Array, o: number, p: Pose): boolean {
  if (!p || !Array.isArray(p.translation) || !Array.isArray(p.rotation)) return false;
  if (p.translation.length !== 3 || p.rotation.length !== 4) return false;
  packPose(out, o, p);
  for (let k = 0; k < POSE; k++) if (!Number.isFinite(out[o + k])) return false;
  return normalizeRotation(out, o) > 1e-12;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** The angle a + 2 pi k inside [min, max], or the one nearest to it. */
function nearestTurn(a: number, min: number, max: number): number {
  let best = a,
    bestDist = Infinity;
  for (let k = -3; k <= 3; k++) {
    const v = a + 2 * Math.PI * k;
    const dist = v < min ? min - v : v > max ? v - max : 0;
    if (dist < bestDist - 1e-12) {
      best = v;
      bestDist = dist;
    }
  }
  return best;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listMates(ids: readonly string[], one: string, many: string): string {
  if (ids.length === 0) return `no other ${one}`;
  if (ids.length === 1) return `${one} ${ids[0]}`;
  return `${many} ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

function describeGap(position: number, angle: number): string {
  const parts: string[] = [];
  if (position > 0) parts.push(`${formatNumber(position)} mm`);
  if (angle > TOL_CONFLICT) parts.push(`${formatNumber((angle * 180) / Math.PI)} degrees`);
  return parts.join(' and ') || 'slightly';
}

function formatNumber(v: number): string {
  return v >= 0.01 ? v.toFixed(2) : v.toPrecision(2);
}

function formatCoordinate(kind: MateKind, v: number): string {
  return kind === 'revolute'
    ? `${formatNumber((v * 180) / Math.PI)} degrees`
    : `${formatNumber(v)} mm`;
}

// API ------------------------------------------------------------------------

/** Solves the assembly from its last poses. */
export function solve(input: AssemblyInput): SolveReport {
  const asm = new Assembly(input);
  asm.buildGraph();
  asm.extractCoordinates();
  asm.closeAll();
  return asm.report(input, []);
}

/**
 * Moves an instance toward a target within the freedom its mates leave: in a tree, the free
 * coordinates between it and its fixed root change as little as needed to get nearest to the
 * target; loops those coordinates close stay closed (the target is soft, the loops are hard).
 * A group not attached to any fixed instance moves rigidly. Limits clamp.
 */
export function drag(input: AssemblyInput, instanceId: string, target: DragTarget): DragReport {
  const asm = new Assembly(input);
  const d = asm.index.get(instanceId);
  const warnings: AssemblyWarning[] = [];
  if (d === undefined) {
    asm.issues.push({
      code: 'unknown-instance',
      instanceId,
      message: `Instance ${instanceId}, the one being dragged, does not exist.`,
    });
  }
  asm.buildGraph(d ?? -1);
  asm.extractCoordinates();
  asm.closeAll();
  if (d !== undefined) {
    if (asm.fixed[d]) {
      warnings.push({
        code: 'fixed-instance',
        instanceId,
        message: `Instance ${instanceId} is fixed, so it cannot be dragged.`,
      });
    } else if (asm.grounded[d]) {
      asm.dragGrounded(d, target);
    } else {
      asm.dragFloating(d, target);
    }
    asm.forward();
  }
  const residual: Residual =
    d === undefined ? { position: Infinity, angle: Infinity } : asm.targetResidual(d, target);
  const reached = residual.position <= TOL_REACHED * asm.L && residual.angle <= TOL_REACHED;
  if (d !== undefined && !reached && !asm.fixed[d]) {
    warnings.push({
      code: 'not-reached',
      instanceId,
      message: `Instance ${instanceId} cannot reach the target; it moved as near as its mates allow.`,
    });
  }
  const report = asm.report(input, warnings);
  return { ...report, target: { ...residual, reached } };
}
