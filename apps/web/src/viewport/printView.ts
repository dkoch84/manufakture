// What the print workspace adds to the viewport (M3 plan, T3.1d): the printer's build volume as a
// wireframe with the plate outline and its excluded areas, and two shading modes for the faces.
//
// - Overhang: a shader that classifies every fragment by the angle from vertical of its world
//   normal (the mesh normal turned by the body's transform, which is the item's orientation), on
//   the GPU every frame, with the classes and conventions of `@manufakture/print` (ADR 0012
//   decision 6): a flat ceiling, an overhang steeper than the threshold, the warning band below
//   it, and faces resting on the bed. Nothing is computed per triangle on the CPU.
// - Thickness: a heat map of the print-analysis worker's per-triangle wall thickness, turned
//   into a per-vertex attribute (the thinnest triangle each vertex belongs to).
//
// Both keep the body's own colour, hover and selection for what they do not flag.

import { BufferAttribute, Color, FrontSide, ShaderMaterial, type Plane } from 'three';
import type { Vec3 } from '@manufakture/kernel';

/** The build volume to draw, in bed coordinates (mm, z up from the bed). */
export interface BuildVolume {
  /** The printable area, a convex polygon at z = 0. */
  area: readonly (readonly [number, number])[];
  height: number;
  /** Areas the printer will not print on. */
  excluded: readonly (readonly (readonly [number, number])[])[];
}

/** How the viewport colours faces; null is the normal shading. */
export type ViewShading =
  | {
      kind: 'overhang';
      /** Radians from vertical. */
      threshold: number;
      /** Width of the warning band below the threshold, radians. */
      band: number;
    }
  | {
      kind: 'thickness';
      /** Per drawn body id: per triangle of its mesh, the wall thickness in mm. */
      values: ReadonlyMap<string, Float32Array>;
      minFeature: number;
      minWall: number;
    };

/** Overhang classes' colours, also used by the legend in the print panel. */
export const OVERHANG_COLORS = {
  steep: '#f2b134',
  overhang: '#e0482f',
  downwardFlat: '#9b1b5a',
  onBed: '#4f7fd8',
} as const;

/** Thickness heat map: thinner than the minimum feature, thin, and the start and end of the ramp. */
export const THICKNESS_COLORS = {
  belowMinFeature: '#5c0b1e',
  thin: '#e0482f',
  thinEnd: '#f29b2e',
  near: '#f2d34a',
  ok: '#68b36b',
} as const;

/**
 * Class boundaries on the GPU allow this many radians. Wider than `@manufakture/print`'s 1e-6:
 * a normal turned by a placement in float32 can be one unit in the last place off vertical, and
 * asin there moves by about 3e-4 rad. The issue list uses the package's exact classes.
 */
const GPU_ANGLE_TOLERANCE = 1e-3;
/** Fragments within this many mm of the bed plane (z = 0) facing down rest on it. */
const BED_TOLERANCE = 1e-3;

/** Line segments (xyz xyz per segment) of a build volume's wireframe. */
export function buildVolumeSegments(volume: BuildVolume): {
  frame: Float32Array;
  excluded: Float32Array;
} {
  const frame: number[] = [];
  const ring = (points: readonly (readonly [number, number])[], z: number, out: number[]) => {
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      out.push(a[0], a[1], z, b[0], b[1], z);
    }
  };
  ring(volume.area, 0, frame);
  ring(volume.area, volume.height, frame);
  for (const p of volume.area) frame.push(p[0], p[1], 0, p[0], p[1], volume.height);
  const excluded: number[] = [];
  for (const polygon of volume.excluded) {
    ring(polygon, 0, excluded);
    // A cross, so the area reads as "not here" from any side.
    if (polygon.length >= 4) {
      const [a, b, c, d] = polygon as readonly (readonly [number, number])[] as [
        readonly [number, number],
        readonly [number, number],
        readonly [number, number],
        readonly [number, number],
      ];
      excluded.push(a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0, d[0], d[1], 0);
    }
  }
  return { frame: new Float32Array(frame), excluded: new Float32Array(excluded) };
}

/** The bounds of a build volume, for framing. */
export function buildVolumeBounds(volume: BuildVolume): { min: Vec3; max: Vec3 } | null {
  if (volume.area.length === 0) return null;
  const xs = volume.area.map((p) => p[0]);
  const ys = volume.area.map((p) => p[1]);
  return {
    min: [Math.min(...xs), Math.min(...ys), 0],
    max: [Math.max(...xs), Math.max(...ys), volume.height],
  };
}

/**
 * Per display vertex, the thinnest of the triangles that use it. `indices` are the display
 * triangles (`ViewBody.indices`, in the mesh's triangle order), `values` per triangle. Vertices
 * no triangle uses, and values that are not finite (nothing within range), get `far`.
 */
export function vertexThickness(
  indices: ArrayLike<number>,
  vertexCount: number,
  values: ArrayLike<number>,
  far = 1e6,
): Float32Array {
  const out = new Float32Array(vertexCount).fill(far);
  const triangles = Math.min(Math.floor(indices.length / 3), values.length);
  for (let t = 0; t < triangles; t++) {
    const v = values[t]!;
    if (!Number.isFinite(v)) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      if (v < out[i]!) out[i] = v;
    }
  }
  return out;
}

/** The `thickness` attribute for a body's display geometry. */
export function thicknessAttribute(
  indices: ArrayLike<number>,
  vertexCount: number,
  values: ArrayLike<number> | undefined,
): BufferAttribute {
  return new BufferAttribute(
    values
      ? vertexThickness(indices, vertexCount, values)
      : new Float32Array(vertexCount).fill(1e6),
    1,
  );
}

const SHARED_VERTEX = /* glsl */ `
  varying vec3 vColor;
  varying vec3 vWorldNormal;
  varying vec3 vViewNormal;
  #include <common>
  #include <clipping_planes_pars_vertex>
`;

// A headlight, so the classes read the same from every side; in linear colour, as the vertex
// colours are, converted to the output colour space at the end like three's own materials.
const LIGHT = /* glsl */ `
  float lightOf(vec3 viewNormal) {
    return 0.35 + 0.65 * abs(normalize(viewNormal).z);
  }
`;

const color = (hex: string) => new Color(hex);

/** The overhang shading material; `threshold` and `band` are uniforms, in radians. */
export function createOverhangMaterial(clippingPlanes: Plane[]): ShaderMaterial {
  return new ShaderMaterial({
    vertexColors: true,
    side: FrontSide,
    clipping: true,
    clippingPlanes,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      uThreshold: { value: Math.PI / 3 },
      uBand: { value: Math.PI / 18 },
      uTolerance: { value: GPU_ANGLE_TOLERANCE },
      uBedTolerance: { value: BED_TOLERANCE },
      uSteep: { value: color(OVERHANG_COLORS.steep) },
      uOverhang: { value: color(OVERHANG_COLORS.overhang) },
      uFlat: { value: color(OVERHANG_COLORS.downwardFlat) },
      uBed: { value: color(OVERHANG_COLORS.onBed) },
    },
    vertexShader: /* glsl */ `
      varying float vWorldZ;
      ${SHARED_VERTEX}
      void main() {
        vColor = color;
        vWorldNormal = mat3(modelMatrix) * normal;
        vViewNormal = normalMatrix * normal;
        vWorldZ = (modelMatrix * vec4(position, 1.0)).z;
        #include <begin_vertex>
        #include <project_vertex>
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uThreshold;
      uniform float uBand;
      uniform float uTolerance;
      uniform float uBedTolerance;
      uniform vec3 uSteep;
      uniform vec3 uOverhang;
      uniform vec3 uFlat;
      uniform vec3 uBed;
      varying vec3 vColor;
      varying vec3 vWorldNormal;
      varying vec3 vViewNormal;
      varying float vWorldZ;
      #include <clipping_planes_pars_fragment>
      ${LIGHT}
      void main() {
        #include <clipping_planes_fragment>
        vec3 n = normalize(vWorldNormal);
        // Angle from vertical: 0 for a wall, pi/2 facing straight down, negative facing up. asin,
        // not atan(-n.z, length(n.xy)): SwiftShader returned about pi/2 from that for walls.
        float a = asin(clamp(-n.z, -1.0, 1.0));
        vec3 c = vColor;
        bool flagged = true;
        if (a > 0.0 && vWorldZ <= uBedTolerance) c = uBed;
        else if (a >= 1.57079632679 - uTolerance) c = uFlat;
        else if (a > uThreshold + uTolerance) c = uOverhang;
        else if (a > uThreshold - uBand + uTolerance) c = uSteep;
        else flagged = false;
        // A selected or hovered face still shows it, faintly.
        if (flagged) c = mix(c, vColor, 0.2);
        gl_FragColor = vec4(c * lightOf(vViewNormal), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The thickness heat map material; the per-vertex `thickness` attribute holds the values. */
export function createThicknessMaterial(clippingPlanes: Plane[]): ShaderMaterial {
  return new ShaderMaterial({
    vertexColors: true,
    side: FrontSide,
    clipping: true,
    clippingPlanes,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      uMinFeature: { value: 0.1 },
      uMinWall: { value: 0.84 },
      uRange: { value: 2.52 },
      uBelow: { value: color(THICKNESS_COLORS.belowMinFeature) },
      uThin: { value: color(THICKNESS_COLORS.thin) },
      uThinEnd: { value: color(THICKNESS_COLORS.thinEnd) },
      uNear: { value: color(THICKNESS_COLORS.near) },
      uOk: { value: color(THICKNESS_COLORS.ok) },
    },
    vertexShader: /* glsl */ `
      attribute float thickness;
      varying float vThickness;
      ${SHARED_VERTEX}
      void main() {
        vColor = color;
        vThickness = thickness;
        vWorldNormal = mat3(modelMatrix) * normal;
        vViewNormal = normalMatrix * normal;
        #include <begin_vertex>
        #include <project_vertex>
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uMinFeature;
      uniform float uMinWall;
      uniform float uRange;
      uniform vec3 uBelow;
      uniform vec3 uThin;
      uniform vec3 uThinEnd;
      uniform vec3 uNear;
      uniform vec3 uOk;
      varying vec3 vColor;
      varying float vThickness;
      varying vec3 vWorldNormal;
      varying vec3 vViewNormal;
      #include <clipping_planes_pars_fragment>
      ${LIGHT}
      void main() {
        #include <clipping_planes_fragment>
        float t = vThickness;
        vec3 c = vColor;
        if (t < uMinFeature) c = uBelow;
        else if (t < uMinWall) c = mix(uThin, uThinEnd, (t - uMinFeature) / max(uMinWall - uMinFeature, 1e-6));
        else if (t < uRange) c = mix(uNear, uOk, (t - uMinWall) / max(uRange - uMinWall, 1e-6));
        if (t < uRange) c = mix(c, vColor, 0.15);
        gl_FragColor = vec4(c * lightOf(vViewNormal), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
