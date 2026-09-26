// Custom three.js materials of the viewport: the pick id pass, the
// silhouette rim and the ground grid.

import { BackSide, Color, DoubleSide, FrontSide, ShaderMaterial, Vector2, type Plane } from 'three';

/** What a pick material draws: triangles, native 1 px lines, or square points. */
export type PickPrimitive = 'faces' | 'lines' | 'points';

/** Size of a vertex in the pick pass, in pixels. */
export const PICK_POINT_SIZE = 3;

/**
 * Renders the 24-bit pick id attribute as RGB, for faces, edges or vertices.
 *
 * Faces are polygon-offset exactly like the shaded faces, so an edge or vertex
 * on a visible face wins the depth test there and one behind the part loses
 * it: the pick pass sees what the screen shows. Back faces write id 0, so the
 * inside of a sectioned body occludes like the cap drawn over it but never
 * picks anything.
 */
export function createPickMaterial(
  clippingPlanes: Plane[],
  primitive: PickPrimitive = 'faces',
): ShaderMaterial {
  const faces = primitive === 'faces';
  return new ShaderMaterial({
    side: faces ? DoubleSide : FrontSide,
    clipping: true,
    clippingPlanes,
    polygonOffset: faces,
    polygonOffsetFactor: faces ? 1 : 0,
    polygonOffsetUnits: faces ? 1 : 0,
    defines: {
      ...(faces ? { PICK_FACES: '' } : {}),
      ...(primitive === 'points' ? { PICK_POINTS: '' } : {}),
    },
    vertexShader: /* glsl */ `
      attribute float pickId;
      flat varying float vPickId;
      #include <common>
      #include <clipping_planes_pars_vertex>
      void main() {
        vPickId = pickId;
        #include <begin_vertex>
        #include <project_vertex>
        #include <clipping_planes_vertex>
        #ifdef PICK_POINTS
          gl_PointSize = ${PICK_POINT_SIZE.toFixed(1)};
        #endif
      }
    `,
    fragmentShader: /* glsl */ `
      flat varying float vPickId;
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        float id = floor(vPickId + 0.5);
        #ifdef PICK_FACES
          if (!gl_FrontFacing) id = 0.0;
        #endif
        float r = mod(id, 256.0);
        float g = mod(floor(id / 256.0), 256.0);
        float b = floor(id / 65536.0);
        gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
      }
    `,
  });
}

/**
 * Silhouette rim: back faces pushed outwards by a constant number of screen
 * pixels. Only the part sticking out past the front faces shows, which draws
 * the outline of curved surfaces that have no B-rep edge there.
 */
export function createSilhouetteMaterial(clippingPlanes: Plane[], color: Color): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    clipping: true,
    clippingPlanes,
    uniforms: {
      uColor: { value: color },
      uWidth: { value: 1.25 },
      uResolution: { value: new Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float uWidth;
      uniform vec2 uResolution;
      #include <common>
      #include <clipping_planes_pars_vertex>
      void main() {
        #include <begin_vertex>
        #include <project_vertex>
        vec4 clipNormal = projectionMatrix * vec4(normalMatrix * normal, 0.0);
        float len = length(clipNormal.xy);
        if (len > 1e-6) {
          gl_Position.xy += clipNormal.xy / len * uWidth * 2.0 / uResolution * gl_Position.w;
        }
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      #include <clipping_planes_pars_fragment>
      void main() {
        #include <clipping_planes_fragment>
        gl_FragColor = vec4(uColor, 1.0);
      }
    `,
  });
}

/**
 * Ground grid on the XY plane (see grid.ts for the spacing rules). Pushed
 * further back than the polygon-offset faces, so a face lying on z = 0 (the
 * bottom of a part standing on the grid) always covers it, from either side.
 */
export function createGridMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
    uniforms: {
      uMinor: { value: 1 },
      uMajor: { value: 10 },
      uMinorFade: { value: 1 },
      uCenter: { value: new Vector2() },
      uExtent: { value: 400 },
      uColor: { value: new Color(0x6b7785) },
      uAxisX: { value: new Color(0xd0453b) },
      uAxisY: { value: new Color(0x3f9a4a) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uMinor;
      uniform float uMajor;
      uniform float uMinorFade;
      uniform vec2 uCenter;
      uniform float uExtent;
      uniform vec3 uColor;
      uniform vec3 uAxisX;
      uniform vec3 uAxisY;
      varying vec3 vWorld;

      // Antialiased lines one pixel wide, whatever the zoom.
      float lines(vec2 coord) {
        vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      float line(float coord) {
        return 1.0 - min(abs(coord) / fwidth(coord), 1.0);
      }

      void main() {
        vec2 p = vWorld.xy;
        float minor = lines(p / uMinor) * uMinorFade * 0.16;
        float major = lines(p / uMajor) * 0.38;
        float alpha = max(minor, major);
        vec3 color = uColor;
        float ax = line(p.y / uMinor);
        float ay = line(p.x / uMinor);
        if (ax > 0.0) { color = mix(color, uAxisX, ax); alpha = max(alpha, ax * 0.8); }
        if (ay > 0.0) { color = mix(color, uAxisY, ay); alpha = max(alpha, ay * 0.8); }
        float d = length(p - uCenter);
        alpha *= 1.0 - smoothstep(uExtent * 0.25, uExtent * 0.5, d);
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}
