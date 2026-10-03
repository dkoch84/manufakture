// The viewport probe: a fixture's members drawn the ways the spike compares, timed frame by
// frame, and picked through a pick pass with a per-instance id. Driven by scripts/measure.ts
// through Playwright (`window.spike`).

import {
  AmbientLight,
  BatchedMesh,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { clipMesh, type MeshData } from '../clip.ts';
import { fixture, type FixtureName } from '../fixtures.ts';
import { placementMatrix } from '../geom.ts';
import { MemberSet, mesherFor } from '../member-set.ts';
import { shapeKey } from '../members.ts';

export type Mode = 'per-member' | 'instanced' | 'batched' | 'merged';

export interface Setup {
  fixture: FixtureName;
  mode: Mode;
  edges: boolean;
  /** Roles left out (the distance LOD: blocking and cripples). */
  hide?: string[];
  /** Representation C: meshes of cut shapes from Manifold, by shape key. */
  cutMeshes?: Record<string, { positions: number[]; normals: number[]; indices: number[] }>;
}

const ROLE_COLORS: Record<string, number> = {
  stud: 0xd8b07a,
  'top-plate': 0xc9965a,
  'bottom-plate': 0xc9965a,
  header: 0xb5784a,
  'common-rafter': 0xa8c47a,
  'jack-rafter': 0x98b46a,
  'hip-rafter': 0x7f9f50,
  joist: 0x9ab8d0,
};

const canvas = document.createElement('canvas');
document.body.style.margin = '0';
document.body.appendChild(canvas);
const width = window.innerWidth;
const height = window.innerHeight;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(width, height);
renderer.setClearColor(0xf4f4f2, 1);
const gl = renderer.getContext();
const pixel = new Uint8Array(4);

let scene = new Scene();
let camera = new PerspectiveCamera(45, width / height, 10, 200_000);
const center = new Vector3();
let radius = 1;
let pickables: InstancedMesh[] = [];
let pickIds: string[] = [];

const pickMaterial = new ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute float pickId;
    flat varying float vPickId;
    #include <common>
    void main() {
      vPickId = pickId;
      #include <begin_vertex>
      #include <project_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    flat varying float vPickId;
    void main() {
      float id = floor(vPickId + 0.5);
      gl_FragColor = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0;
    }
  `,
});
const pickTarget = new WebGLRenderTarget(1, 1);

function geometryOf(mesh: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** World-space edge segments of the given (geometry, matrix) pairs, as one LineSegments. */
function mergedEdges(
  items: Array<{ edges: Float32Array; matrix: Matrix4 }>,
  material: LineBasicMaterial,
): LineSegments {
  let n = 0;
  for (const it of items) n += it.edges.length;
  const out = new Float32Array(n);
  const v = new Vector3();
  let o = 0;
  for (const it of items)
    for (let i = 0; i < it.edges.length; i += 3) {
      v.set(it.edges[i]!, it.edges[i + 1]!, it.edges[i + 2]!).applyMatrix4(it.matrix);
      out[o++] = v.x;
      out[o++] = v.y;
      out[o++] = v.z;
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(out, 3));
  return new LineSegments(g, material);
}

function mergedMesh(
  items: Array<{ geometry: BufferGeometry; matrix: Matrix4 }>,
  material: MeshStandardMaterial,
): Mesh {
  let verts = 0;
  let idx = 0;
  for (const it of items) {
    verts += it.geometry.attributes.position!.count;
    idx += it.geometry.index!.count;
  }
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const ind = new Uint32Array(idx);
  const v = new Vector3();
  const normalMatrix = new Matrix4();
  let vo = 0;
  let io = 0;
  for (const it of items) {
    const p = it.geometry.attributes.position!.array;
    const q = it.geometry.attributes.normal!.array;
    const index = it.geometry.index!.array;
    normalMatrix.extractRotation(it.matrix);
    const base = vo / 3;
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i]!, p[i + 1]!, p[i + 2]!).applyMatrix4(it.matrix);
      pos.set([v.x, v.y, v.z], vo);
      v.set(q[i]!, q[i + 1]!, q[i + 2]!).applyMatrix4(normalMatrix);
      nrm.set([v.x, v.y, v.z], vo);
      vo += 3;
    }
    for (let i = 0; i < index.length; i++) ind[io++] = index[i]! + base;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setIndex(new BufferAttribute(ind, 1));
  return new Mesh(g, material);
}

function setup(o: Setup) {
  scene = new Scene();
  pickables = [];
  pickIds = [];
  const t0 = performance.now();
  const f = fixture(o.fixture);
  const t1 = performance.now();
  const cut = o.cutMeshes;
  const set = new MemberSet(
    mesherFor((m) => {
      const c = cut?.[shapeKey(m)];
      return c
        ? {
            positions: new Float32Array(c.positions),
            normals: new Float32Array(c.normals),
            indices: new Uint32Array(c.indices),
          }
        : clipMesh(m);
    }),
  );
  for (const [g, ms] of f.groups) set.setGroup(g, ms);
  const t2 = performance.now();
  const hide = new Set(o.hide ?? []);
  const members = set.members().filter((m) => !hide.has(m.role));
  const geometries = new Map<string, BufferGeometry>();
  const edgeArrays = new Map<string, Float32Array>();
  for (const [key, mesh] of set.meshes) {
    const g = geometryOf(mesh);
    geometries.set(key, g);
    edgeArrays.set(key, new EdgesGeometry(g).attributes.position!.array as Float32Array);
  }
  const material = new MeshStandardMaterial({
    color: 0xd8b07a,
    roughness: 0.62,
    metalness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const roleMaterial = new Map<string, MeshStandardMaterial>();
  const matFor = (role: string) => {
    let m = roleMaterial.get(role);
    if (!m) {
      m = material.clone();
      m.color = new Color(ROLE_COLORS[role] ?? 0xd8b07a);
      roleMaterial.set(role, m);
    }
    return m;
  };
  const edgeMaterial = new LineBasicMaterial({ color: 0x2a2a2a });
  const matrixOf = (m: (typeof members)[number]) =>
    new Matrix4().fromArray(placementMatrix(m.placement));
  const byGroup = new Map<string, typeof members>();
  for (const m of members) byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m]);

  if (o.mode === 'per-member') {
    // Today's viewport: an object (and an edge object) per body.
    for (const m of members) {
      const key = shapeKey(m);
      const mesh = new Mesh(geometries.get(key)!, matFor(m.role));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrixOf(m));
      scene.add(mesh);
      if (o.edges) {
        const e = new LineSegments(
          new BufferGeometry().setAttribute(
            'position',
            new BufferAttribute(edgeArrays.get(key)!, 3),
          ),
          edgeMaterial,
        );
        e.matrixAutoUpdate = false;
        e.matrix.copy(mesh.matrix);
        scene.add(e);
      }
    }
  } else if (o.mode === 'instanced') {
    const lists = new Map<string, typeof members>();
    for (const m of members) {
      const k = `${m.role}|${shapeKey(m)}`;
      lists.set(k, [...(lists.get(k) ?? []), m]);
    }
    for (const [k, ms] of lists) {
      const key = k.slice(k.indexOf('|') + 1);
      const geometry = geometries.get(key)!.clone();
      const ids = new Float32Array(ms.length);
      const im = new InstancedMesh(geometry, matFor(ms[0]!.role), ms.length);
      ms.forEach((m, i) => {
        im.setMatrixAt(i, matrixOf(m));
        pickIds.push(`${m.group}:${m.id}`);
        ids[i] = pickIds.length; // 1-based; 0 is the background
      });
      geometry.setAttribute('pickId', new InstancedBufferAttribute(ids, 1));
      im.computeBoundingSphere();
      scene.add(im);
      pickables.push(im);
    }
  } else if (o.mode === 'batched') {
    let verts = 0;
    let idx = 0;
    for (const g of geometries.values()) {
      verts += g.attributes.position!.count;
      idx += g.index!.count;
    }
    const bm = new BatchedMesh(members.length, verts, idx, material);
    const geomIds = new Map<string, number>();
    for (const [key, g] of geometries) geomIds.set(key, bm.addGeometry(g));
    for (const m of members) {
      const id = bm.addInstance(geomIds.get(shapeKey(m))!);
      bm.setMatrixAt(id, matrixOf(m));
      bm.setColorAt(id, new Color(ROLE_COLORS[m.role] ?? 0xd8b07a));
    }
    scene.add(bm);
  } else {
    // Far LOD: each group (wall, floor, roof) merged into one mesh in world coordinates.
    for (const ms of byGroup.values()) {
      scene.add(
        mergedMesh(
          ms.map((m) => ({ geometry: geometries.get(shapeKey(m))!, matrix: matrixOf(m) })),
          material,
        ),
      );
    }
  }
  if (o.edges && o.mode !== 'per-member')
    for (const ms of byGroup.values())
      scene.add(
        mergedEdges(
          ms.map((m) => ({ edges: edgeArrays.get(shapeKey(m))!, matrix: matrixOf(m) })),
          edgeMaterial,
        ),
      );

  scene.add(new AmbientLight(0xffffff, 0.9));
  const light = new DirectionalLight(0xffffff, 1.6);
  light.position.set(1, -2, 3);
  scene.add(light);
  const box = new Box3().setFromObject(scene);
  box.getCenter(center);
  radius = box.getSize(new Vector3()).length() / 2;
  camera = new PerspectiveCamera(45, width / height, radius / 100, radius * 10);
  orbit(0);
  const t3 = performance.now();
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const t4 = performance.now();
  let geometryBytes = 0;
  scene.traverse((obj: Object3D) => {
    const g = (obj as Mesh).geometry as BufferGeometry | undefined;
    if (!g) return;
    for (const a of Object.values(g.attributes))
      geometryBytes += (a as BufferAttribute).array.byteLength;
    if (g.index) geometryBytes += g.index.array.byteLength;
  });
  return {
    members: members.length,
    objects: scene.children.length,
    generateMs: t1 - t0,
    meshMs: t2 - t1,
    sceneMs: t3 - t2,
    firstFrameMs: t4 - t3,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    lines: renderer.info.render.lines,
    geometryBytes,
  };
}

function orbit(angle: number, elevation = 0.6) {
  const d = radius * 2.2;
  camera.position.set(
    center.x + d * Math.cos(angle),
    center.y + d * Math.sin(angle),
    center.z + d * elevation,
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(center);
  camera.updateMatrixWorld();
}

function frames(n: number) {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    orbit((i / n) * Math.PI * 2);
    const t0 = performance.now();
    renderer.render(scene, camera);
    // Wait for the GPU (SwiftShader here) to finish the frame.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: times[times.length >> 1]!,
    p95Ms: times[Math.floor(times.length * 0.95)]!,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}

/** GPU pick of one pixel (CSS pixels from the top left): `<group>:<member id>` or null. */
function gpuPick(x: number, y: number): string | null {
  const saved = scene.overrideMaterial;
  const hidden: Object3D[] = [];
  scene.traverse((o) => {
    if ((o as LineSegments).isLineSegments && o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  });
  scene.overrideMaterial = pickMaterial;
  camera.setViewOffset(width, height, x, y, 1, 1);
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pixel);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0xf4f4f2, 1);
  camera.clearViewOffset();
  scene.overrideMaterial = saved;
  for (const o of hidden) o.visible = true;
  const id = pixel[0]! | (pixel[1]! << 8) | (pixel[2]! << 16);
  return id === 0 ? null : (pickIds[id - 1] ?? `unknown ${id}`);
}

const raycaster = new Raycaster();

function rayPick(x: number, y: number): string | null {
  // Through the pixel's centre, where the pick pass samples it.
  raycaster.setFromCamera(
    new Vector2(((x + 0.5) / width) * 2 - 1, -((y + 0.5) / height) * 2 + 1),
    camera,
  );
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (!hit || hit.instanceId === undefined) return null;
  const im = hit.object as InstancedMesh;
  const ids = im.geometry.getAttribute('pickId') as InstancedBufferAttribute;
  return pickIds[ids.getX(hit.instanceId) - 1] ?? null;
}

/** Pick `n` pixels at the projected centres of random members; GPU pick against the raycaster. */
function pick(n: number) {
  orbit(0.6);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const gpu: number[] = [];
  const ray: number[] = [];
  let agree = 0;
  let hits = 0;
  const mismatches: Array<[string | null, string | null]> = [];
  const m = new Matrix4();
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    const im = pickables[Math.floor(rand() * pickables.length)]!;
    im.getMatrixAt(Math.floor(rand() * im.count), m);
    im.geometry.boundingBox!.getCenter(v);
    v.applyMatrix4(m).project(camera);
    const x = Math.round(((v.x + 1) / 2) * width);
    const y = Math.round(((1 - v.y) / 2) * height);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    let t0 = performance.now();
    const a = gpuPick(x, y);
    gpu.push(performance.now() - t0);
    t0 = performance.now();
    const b = rayPick(x, y);
    ray.push(performance.now() - t0);
    if (a !== null) hits++;
    if (a === b) agree++;
    else if (mismatches.length < 8) mismatches.push([a, b]);
  }
  gpu.sort((p, q) => p - q);
  ray.sort((p, q) => p - q);
  return {
    picks: gpu.length,
    hits,
    agree,
    gpuMedianMs: gpu[gpu.length >> 1] ?? 0,
    rayMedianMs: ray[ray.length >> 1] ?? 0,
    mismatches,
  };
}

declare global {
  interface Window {
    spike: {
      setup: typeof setup;
      frames: typeof frames;
      pick: typeof pick;
      renderer: () => string;
      look: (angle: number, elevation: number) => void;
    };
  }
}

window.spike = {
  setup,
  look: (angle, elevation) => {
    orbit(angle, elevation);
    renderer.render(scene, camera);
  },
  frames,
  pick,
  renderer: () => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  },
};
