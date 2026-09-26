// Spike page: starts the geometry worker, asks it for a mesh and renders it with
// one colour per B-rep face. Also exposes window.spike for the Playwright-driven
// measurement script.

import * as Comlink from 'comlink';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { MeshData, PipelineOptions } from './pipeline.ts';
import type { HeapTrace, InitOptions, InitReport, LoadMode, Variant } from './protocol.ts';
import type { WorkerApi } from './worker.ts';

const status = document.querySelector<HTMLPreElement>('#status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f2f2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(1, 1.5, 2);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.addEventListener('change', draw);

let current: THREE.Mesh | null = null;

function draw() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (
    canvas.width !== w * renderer.getPixelRatio() ||
    canvas.height !== h * renderer.getPixelRatio()
  ) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
}
window.addEventListener('resize', draw);

/** Build a three.js mesh with one material (colour) per B-rep face. */
function show(mesh: MeshData): number {
  const t0 = performance.now();
  if (current) {
    scene.remove(current);
    current.geometry.dispose();
    for (const m of current.material as THREE.Material[]) m.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const materials: THREE.Material[] = [];
  for (let f = 0; f < mesh.faceRanges.length / 2; f++) {
    geometry.addGroup(mesh.faceRanges[f * 2]!, mesh.faceRanges[f * 2 + 1]!, f);
    // Golden-angle hue steps keep neighbouring face ids visually distinct.
    const color = new THREE.Color().setHSL((f * 0.381966) % 1, 0.65, 0.55);
    materials.push(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 }));
  }
  current = new THREE.Mesh(geometry, materials);
  scene.add(current);

  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere!;
  controls.target.copy(sphere.center);
  camera.position
    .copy(sphere.center)
    .add(new THREE.Vector3(1.2, -1.6, 1.1).multiplyScalar(sphere.radius * 1.6));
  controls.update();
  draw();
  return performance.now() - t0;
}

let worker: Worker | null = null;
let remote: Comlink.Remote<WorkerApi> | null = null;

function api(): Comlink.Remote<WorkerApi> {
  if (!remote) throw new Error('start() first');
  return remote;
}

const spike = {
  async start(options: InitOptions) {
    const t0 = performance.now();
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    remote = Comlink.wrap<WorkerApi>(worker);
    const report: InitReport = await remote.init(options);
    const mainThreadMs = performance.now() - t0;
    const env = await remote.env();
    status.textContent = `${options.variant}/${options.load}: ready in ${mainThreadMs.toFixed(0)} ms`;
    return { mainThreadMs, report, env };
  },

  async run(options: PipelineOptions, render = true) {
    const t0 = performance.now();
    const mesh = await api().run(options);
    const roundTripMs = performance.now() - t0;
    const renderMs = render ? show(mesh) : null;
    status.textContent =
      `${options.part}: ${mesh.stats.faces} faces, ${mesh.stats.triangles} triangles, ` +
      `${mesh.stats.filletedEdges} filleted edges, ${roundTripMs.toFixed(0)} ms`;
    return { stats: mesh.stats, timings: mesh.timings, roundTripMs, renderMs };
  },

  /** Terminate the worker, which frees its whole WASM heap (recycling). */
  stop() {
    remote?.[Comlink.releaseProxy]();
    worker?.terminate();
    worker = null;
    remote = null;
  },

  heapTrace(options: PipelineOptions, runs: number): Promise<HeapTrace> {
    return api().heapTrace(options, runs);
  },

  heap(): Promise<number> {
    return api().heap();
  },
};

declare global {
  interface Window {
    spike: typeof spike;
  }
}
window.spike = spike;

// Manual use: open /?variant=multi&part=box to see a part without the script.
const params = new URLSearchParams(location.search);
if (params.get('manual') !== '0') {
  const variant = (params.get('variant') ?? 'single') as Variant;
  const load = (params.get('load') ?? 'streaming') as LoadMode;
  const part = params.get('part') === 'box' ? 'box' : 'bracket';
  spike
    .start({ variant, load })
    .then(() =>
      spike.run({
        part,
        filletRadius: part === 'box' ? 2 : 1.5,
        linearDeflection: 0.1,
        angularDeflection: 0.5,
        parallel: variant === 'multi',
      }),
    )
    .catch((error: unknown) => {
      status.textContent = String(error);
    });
}
