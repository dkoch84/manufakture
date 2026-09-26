// The view cube: a small cube in the top right corner that turns with the
// camera. Its 26 regions (faces, edges, corners; see viewMath.ts) are
// separate meshes, so hovering one highlights exactly that region and a click
// selects the view looking from its direction.

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  type Quaternion,
  type WebGLRenderer,
} from 'three';
import {
  CUBE_REGIONS,
  cubePiece,
  eyeDirection,
  orientationFor,
  regionKey,
  type CubeRegion,
} from './viewMath';

const BEVEL = 0.2;
const COLORS = {
  face: new Color(0xeef1f4),
  edge: new Color(0xd6dce3),
  hover: new Color(0x7fb2ff),
};

export interface CubeRect {
  x: number;
  y: number;
  size: number;
}

export class ViewCube {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
  private readonly pieces: Mesh[] = [];
  private readonly regionOf = new Map<Mesh, CubeRegion>();
  private readonly raycaster = new Raycaster();
  private hovered: Mesh | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    readonly sizePx = 110,
    readonly marginPx = 12,
  ) {
    for (const region of CUBE_REGIONS) {
      const { center, size } = cubePiece(region.dir, BEVEL);
      const geometry = new BoxGeometry(...size);
      const material = new MeshBasicMaterial({ color: this.baseColor(region) });
      const mesh = new Mesh(geometry, material);
      mesh.position.set(...center);
      mesh.name = `view-cube:${regionKey(region.dir)}`;
      this.scene.add(mesh);
      this.pieces.push(mesh);
      this.regionOf.set(mesh, region);
      this.disposables.push(geometry, material);
    }
    for (const region of CUBE_REGIONS.filter((r) => r.kind === 'face')) {
      const texture = labelTexture(region.label.toUpperCase());
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
      });
      const geometry = new PlaneGeometry(1 - 2 * BEVEL + 0.12, 1 - 2 * BEVEL + 0.12);
      const label = new Mesh(geometry, material);
      // Oriented like the camera of that view, so the text reads upright in it.
      label.quaternion.copy(orientationFor(region.dir));
      label.position.set(...(region.dir.map((c) => c * 0.502) as [number, number, number]));
      this.scene.add(label);
      this.disposables.push(texture, material, geometry);
    }
    const outline = new EdgesGeometry(new BoxGeometry(1, 1, 1));
    const outlineMaterial = new LineBasicMaterial({ color: 0x8a96a3 });
    this.scene.add(new LineSegments(outline, outlineMaterial));
    this.disposables.push(outline, outlineMaterial);
  }

  /** Where the cube is drawn, in CSS pixels from the canvas's top left. */
  rect(width: number): CubeRect {
    return { x: width - this.sizePx - this.marginPx, y: this.marginPx, size: this.sizePx };
  }

  contains(width: number, x: number, y: number): boolean {
    const r = this.rect(width);
    return x >= r.x && x <= r.x + r.size && y >= r.y && y <= r.y + r.size;
  }

  /** The region under a canvas point, or null. */
  regionAt(width: number, x: number, y: number): CubeRegion | null {
    const mesh = this.meshAt(width, x, y);
    return mesh ? (this.regionOf.get(mesh) ?? null) : null;
  }

  /** Highlight the region under the point; returns true when the highlight changed. */
  hover(width: number, x: number | null, y: number | null): boolean {
    const mesh = x === null || y === null ? null : this.meshAt(width, x, y);
    if (mesh === this.hovered) return false;
    if (this.hovered) this.setColor(this.hovered, this.baseColor(this.regionOf.get(this.hovered)!));
    if (mesh) this.setColor(mesh, COLORS.hover);
    this.hovered = mesh;
    return true;
  }

  render(renderer: WebGLRenderer, width: number, height: number, orientation: Quaternion): void {
    this.camera.quaternion.copy(orientation);
    this.camera.position.copy(eyeDirection(orientation).multiplyScalar(3));
    this.camera.updateMatrixWorld();
    const r = this.rect(width);
    const y = height - r.y - r.size; // WebGL viewports start at the bottom
    renderer.setViewport(r.x, y, r.size, r.size);
    renderer.setScissor(r.x, y, r.size, r.size);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private meshAt(width: number, x: number, y: number): Mesh | null {
    if (!this.contains(width, x, y)) return null;
    const r = this.rect(width);
    const ndc = new Vector2(((x - r.x) / r.size) * 2 - 1, -(((y - r.y) / r.size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects<Mesh<BufferGeometry>>(this.pieces, false)[0];
    return hit ? hit.object : null;
  }

  private baseColor(region: CubeRegion): Color {
    return region.kind === 'face' ? COLORS.face : COLORS.edge;
  }

  private setColor(mesh: Mesh, color: Color): void {
    (mesh.material as MeshBasicMaterial).color.copy(color);
  }
}

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#2b3440';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 64, 120);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
