// The simulation's three.js objects (M5 plan, T5.3c): the displaced grid (`geometry.ts`) as one
// mesh with vertex colours, in a group placed on the part by the WCS frame, as the preview's own
// overlay is. A new frame of the same size rewrites the buffers in place; the overlay owns its
// geometry and material, and `dispose` frees them.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type { Heightmap, WcsFrame } from '@manufakture/cam';
import { frameMatrix } from '../preview/scene';
import { simGridData, simGridIndices, type SimGridData } from './geometry';

export class SimulationOverlay {
  readonly root = new Group();
  private readonly material = new MeshStandardMaterial({
    vertexColors: true,
    side: DoubleSide,
    roughness: 0.85,
    metalness: 0,
  });
  private geometry: BufferGeometry | null = null;
  private mesh: Mesh | null = null;
  private data: SimGridData | null = null;

  constructor(
    frame: WcsFrame,
    private readonly stockTop: number,
  ) {
    this.root.name = 'cam-simulation';
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(frameMatrix(frame));
    this.root.matrixWorldNeedsUpdate = true;
  }

  /** Show a heightmap (and its classes); returns the grid drawn. */
  update(heightmap: Heightmap, classes?: Uint8Array): SimGridData {
    const data = simGridData(heightmap, this.stockTop, classes, this.data ?? undefined);
    if (this.geometry && this.data?.positions === data.positions) {
      this.geometry.getAttribute('position').needsUpdate = true;
      this.geometry.getAttribute('color').needsUpdate = true;
    } else {
      this.disposeGeometry();
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(data.positions, 3));
      g.setAttribute('color', new BufferAttribute(data.colors, 3));
      g.setIndex(new BufferAttribute(simGridIndices(data.nx, data.ny), 1));
      this.geometry = g;
      this.mesh = new Mesh(g, this.material);
      this.mesh.name = 'cam-simulation-grid';
      this.root.add(this.mesh);
    }
    this.geometry!.computeVertexNormals();
    this.geometry!.computeBoundingSphere();
    this.data = data;
    return data;
  }

  /** The grid drawn last, or null before the first update. */
  get grid(): SimGridData | null {
    return this.data;
  }

  dispose(): void {
    this.disposeGeometry();
    this.material.dispose();
  }

  private disposeGeometry(): void {
    if (this.mesh) this.root.remove(this.mesh);
    this.geometry?.dispose();
    this.geometry = null;
    this.mesh = null;
  }
}
