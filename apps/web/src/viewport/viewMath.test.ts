import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CUBE_REGIONS,
  STANDARD_VIEWS,
  cubePiece,
  easeInOutCubic,
  eyeDirection,
  fitSphere,
  interpolateView,
  orbit,
  orientationFor,
  pan,
  panDepthScale,
  perspectiveDistance,
  pointInTargetPlane,
  regionLabel,
  screenRight,
  screenUp,
  withDirection,
  zoomAbout,
  zoomAt,
  type ViewState,
  type Vec3Tuple,
} from './viewMath';

function view(dir: Vec3Tuple = STANDARD_VIEWS.iso, halfHeight = 10): ViewState {
  return { target: new Vector3(0, 0, 0), orientation: orientationFor(dir), halfHeight };
}

function expectVec(v: Vector3, x: number, y: number, z: number, digits = 6) {
  expect(v.x).toBeCloseTo(x, digits);
  expect(v.y).toBeCloseTo(y, digits);
  expect(v.z).toBeCloseTo(z, digits);
}

describe('standard views (Z up)', () => {
  it('front looks along +Y with Z up and X right', () => {
    const q = orientationFor(STANDARD_VIEWS.front);
    expectVec(eyeDirection(q), 0, -1, 0);
    expectVec(screenUp(q), 0, 0, 1);
    expectVec(screenRight(q), 1, 0, 0);
  });

  it('right looks along -X with Y going right', () => {
    const q = orientationFor(STANDARD_VIEWS.right);
    expectVec(eyeDirection(q), 1, 0, 0);
    expectVec(screenRight(q), 0, 1, 0);
    expectVec(screenUp(q), 0, 0, 1);
  });

  it('top looks down with X right and Y up the screen', () => {
    const q = orientationFor(STANDARD_VIEWS.top);
    expectVec(eyeDirection(q), 0, 0, 1);
    expectVec(screenRight(q), 1, 0, 0);
    expectVec(screenUp(q), 0, 1, 0);
  });

  it('bottom keeps X to the right', () => {
    const q = orientationFor(STANDARD_VIEWS.bottom);
    expectVec(eyeDirection(q), 0, 0, -1);
    expectVec(screenRight(q), 1, 0, 0);
  });

  it('iso sees front, right and top with Z pointing up the screen', () => {
    const q = orientationFor(STANDARD_VIEWS.iso);
    const s = 1 / Math.sqrt(3);
    expectVec(eyeDirection(q), s, -s, s);
    expect(screenUp(q).z).toBeGreaterThan(0);
    expect(screenRight(q).z).toBeCloseTo(0, 9);
  });

  it('withDirection keeps target and zoom', () => {
    const v = { ...view(), target: new Vector3(1, 2, 3), halfHeight: 42 };
    const w = withDirection(v, STANDARD_VIEWS.top);
    expectVec(w.target, 1, 2, 3);
    expect(w.halfHeight).toBe(42);
    expectVec(eyeDirection(w.orientation), 0, 0, 1);
  });
});

describe('orbit', () => {
  it('a horizontal drag to the right moves the eye to the left of the model', () => {
    const v = orbit(view(STANDARD_VIEWS.front), 50, 0);
    const eye = eyeDirection(v.orientation);
    expect(eye.x).toBeLessThan(0);
    expect(eye.z).toBeCloseTo(0, 9);
  });

  it('a vertical drag downwards raises the eye', () => {
    const v = orbit(view(STANDARD_VIEWS.front), 0, 50);
    expect(eyeDirection(v.orientation).z).toBeGreaterThan(0);
  });

  it('horizontal orbit never rolls: screen right stays horizontal', () => {
    let v = view(STANDARD_VIEWS.iso);
    for (let i = 0; i < 20; i++) v = orbit(v, 37, 0);
    expect(screenRight(v.orientation).z).toBeCloseTo(0, 9);
  });

  it('keeps the target and the zoom', () => {
    const v = orbit({ ...view(), target: new Vector3(5, 5, 5) }, 10, 10);
    expectVec(v.target, 5, 5, 5);
    expect(v.halfHeight).toBe(10);
  });

  it('does not mutate its input', () => {
    const v = view();
    const before = v.orientation.clone();
    orbit(v, 10, 10);
    expect(v.orientation.equals(before)).toBe(true);
  });
});

describe('pan', () => {
  it('moves the target opposite to the drag so the model follows the cursor', () => {
    // halfHeight 10 over 200 px: 0.1 mm per pixel.
    const v = pan(view(STANDARD_VIEWS.front), 10, 20, 200);
    expectVec(v.target, -1, 0, 2);
  });
});

describe('pan depth', () => {
  it('is 1 in the target plane, below 1 in front of it and above 1 behind it', () => {
    const v = view(STANDARD_VIEWS.front, 10);
    const d = perspectiveDistance(10, 35);
    expect(panDepthScale(v, new Vector3(5, 0, 3), 35)).toBeCloseTo(1);
    expect(panDepthScale(v, new Vector3(0, -d / 2, 0), 35)).toBeCloseTo(0.5);
    expect(panDepthScale(v, new Vector3(0, d, 0), 35)).toBeCloseTo(2);
  });

  it('is clamped near and behind the eye', () => {
    const v = view(STANDARD_VIEWS.front, 10);
    expect(panDepthScale(v, new Vector3(0, -1e9, 0), 35)).toBe(0.05);
  });

  it('scales the pan', () => {
    const a = pan(view(STANDARD_VIEWS.front), 10, 0, 200, 2);
    expectVec(a.target, -2, 0, 0);
  });
});

describe('zoom at the cursor', () => {
  it('keeps the point under the cursor fixed', () => {
    const v = view(STANDARD_VIEWS.front);
    const ndc = { x: 0.5, y: -0.25 };
    const before = pointInTargetPlane(v, ndc, 1.6);
    const z = zoomAt(v, ndc, 0.5, 1.6);
    const after = pointInTargetPlane(z, ndc, 1.6);
    expect(z.halfHeight).toBe(5);
    expectVec(after, before.x, before.y, before.z);
  });

  it('zooming at the centre does not move the target', () => {
    const z = zoomAt(view(), { x: 0, y: 0 }, 2, 1);
    expectVec(z.target, 0, 0, 0);
    expect(z.halfHeight).toBe(20);
  });

  it('keeps any pivot fixed on screen, in front of or behind the target plane', () => {
    const fov = 35;
    const aspect = 1.5;
    const v = view(STANDARD_VIEWS.iso, 20);
    const pivot = new Vector3(8, -3, 12);
    const screen = (w: ViewState) => {
      // Perspective projection of the pivot, by hand.
      const eye = w.target
        .clone()
        .addScaledVector(eyeDirection(w.orientation), perspectiveDistance(w.halfHeight, fov));
      const rel = pivot.clone().sub(eye);
      const depth = -rel.dot(eyeDirection(w.orientation));
      const t = Math.tan((fov * Math.PI) / 360);
      return [
        rel.dot(screenRight(w.orientation)) / (depth * t * aspect),
        rel.dot(screenUp(w.orientation)) / (depth * t),
      ];
    };
    const before = screen(v);
    const z = zoomAbout(v, pivot, 0.6);
    const after = screen(z);
    expect(z.halfHeight).toBeCloseTo(12);
    expect(after[0]).toBeCloseTo(before[0]!, 9);
    expect(after[1]).toBeCloseTo(before[1]!, 9);
  });

  it('clamps extreme zoom', () => {
    const z = zoomAt(view(), { x: 0, y: 0 }, 1e-12, 1);
    expect(z.halfHeight).toBeGreaterThan(0);
  });
});

describe('fit and projections', () => {
  it('frames a sphere with a margin, widening for tall viewports', () => {
    const sphere = { center: new Vector3(1, 2, 3), radius: 10 };
    const wide = fitSphere(view(), sphere, 2, 1.1);
    expectVec(wide.target, 1, 2, 3);
    expect(wide.halfHeight).toBeCloseTo(11);
    const tall = fitSphere(view(), sphere, 0.5, 1.1);
    expect(tall.halfHeight).toBeCloseTo(22);
  });

  it('a perspective camera at perspectiveDistance fully contains the fitted sphere', () => {
    const fov = 35;
    const r = 10;
    const halfHeight = fitSphere(view(), { center: new Vector3(), radius: r }, 1).halfHeight;
    const d = perspectiveDistance(halfHeight, fov);
    // The sphere fits when its angular radius is inside the half field of view.
    expect(Math.asin(r / d)).toBeLessThan((fov * Math.PI) / 360);
  });

  it('perspective distance at 90 degrees equals the half height', () => {
    expect(perspectiveDistance(5, 90)).toBeCloseTo(5);
  });
});

describe('animated transitions', () => {
  it('eases from 0 to 1, symmetric about the middle', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });

  it('starts and ends at the two views and zooms on a log scale', () => {
    const a = { ...view(STANDARD_VIEWS.front, 1), target: new Vector3(0, 0, 0) };
    const b = { ...view(STANDARD_VIEWS.top, 100), target: new Vector3(10, 0, 0) };
    const start = interpolateView(a, b, 0);
    const end = interpolateView(a, b, 1);
    expect(start.orientation.angleTo(a.orientation)).toBeCloseTo(0);
    expect(end.orientation.angleTo(b.orientation)).toBeCloseTo(0);
    expectVec(end.target, 10, 0, 0);
    expect(interpolateView(a, b, 0.5).halfHeight).toBeCloseTo(10);
  });

  it('rotates along the shortest arc', () => {
    const a = view(STANDARD_VIEWS.front);
    const b = view(STANDARD_VIEWS.right);
    const mid = interpolateView(a, b, 0.5);
    const total = a.orientation.angleTo(b.orientation);
    expect(a.orientation.angleTo(mid.orientation)).toBeCloseTo(total / 2, 5);
    expect(total).toBeCloseTo(Math.PI / 2, 5);
    expect(mid.orientation).toBeInstanceOf(Quaternion);
  });
});

describe('view cube regions', () => {
  it('has 6 faces, 12 edges and 8 corners', () => {
    const count = (k: string) => CUBE_REGIONS.filter((r) => r.kind === k).length;
    expect(CUBE_REGIONS).toHaveLength(26);
    expect(count('face')).toBe(6);
    expect(count('edge')).toBe(12);
    expect(count('corner')).toBe(8);
  });

  it('labels regions after the standard views', () => {
    expect(regionLabel([0, -1, 0])).toBe('Front');
    expect(regionLabel([1, 0, 0])).toBe('Right');
    expect(regionLabel([0, 0, 1])).toBe('Top');
    expect(regionLabel([1, -1, 1])).toBe('Top Front Right');
    expect(regionLabel([-1, 1, 0])).toBe('Back Left');
  });

  it('every region selects a view looking from its direction', () => {
    for (const r of CUBE_REGIONS) {
      const eye = eyeDirection(orientationFor(r.dir));
      const d = new Vector3(...r.dir).normalize();
      expect(eye.distanceTo(d)).toBeLessThan(1e-9);
    }
  });

  it('pieces tile the shell of the unit cube exactly', () => {
    const bevel = 0.2;
    let volume = 0;
    for (const r of CUBE_REGIONS) {
      const { center, size } = cubePiece(r.dir, bevel);
      volume += size[0] * size[1] * size[2];
      for (let a = 0; a < 3; a++) {
        // Every piece stays inside the cube and touches its surface on its non-zero axes.
        expect(Math.abs(center[a]!) + size[a]! / 2).toBeLessThanOrEqual(0.5 + 1e-12);
        if (r.dir[a] !== 0) expect(Math.abs(center[a]!) + size[a]! / 2).toBeCloseTo(0.5, 12);
      }
    }
    expect(volume).toBeCloseTo(1 - (1 - 2 * bevel) ** 3, 12);
  });
});
