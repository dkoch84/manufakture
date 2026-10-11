// Layered winding on a spool (task T9.3b): the pure geometry, in SI (metres), with no document
// vocabulary. The spool's reader (./spool) and its records (./records) build on these, and so can
// the simulation (T9.4b: radius against extension) and the spool and cable checks (T9.5e).
//
// The model, the usual hand calculation for a winch drum:
//
// - Simple stacked winding: every turn of a layer sits straight on top of a turn of the layer
//   below, so each layer adds exactly one cable diameter to the radius. Real winding nests
//   partly into the grooves of the layer below (fully nested adds d·√3/2 per layer), so the
//   stacked radius is the upper bound: the most torque per newton of cable tension.
// - Turns per layer N = floor(w / d): the cable centres sit from d/2 to w - d/2 across the width
//   between the flanges. The same N in every layer (nesting would alternate N and N - 1).
// - Layer n (1 at the core) has its cable centres on the pitch radius
//     r_n = r_core + d/2 + (n - 1) d
//   and holds L_n = N · 2π r_n of cable.
// - The cable is wound on from the core outward, the last layer possibly partial, and paid out
//   from the outermost layer first. The cable leaves the spool at the pitch radius of the layer
//   it is coming off, so the effective radius steps down one diameter each time a layer empties.
// - The whole length is on the spool at zero extension; at an extension equal to the length the
//   last turn leaves layer 1.

/** A spool's winding geometry, metres. */
export interface SpoolGeometry {
  /** Diameter of the core (the drum the first layer lies on). */
  core: number;
  /** Width between the flanges, where the cable lies. */
  width: number;
  /** Outside diameter of the flanges; absent for a drum read without one. */
  flange?: number;
}

/** One layer of the winding, as wound at zero extension. */
export interface WoundLayer {
  /** 1 at the core. */
  n: number;
  /** Pitch radius: to the cable's centre, m. */
  radius: number;
  /** Turns of cable in this layer (the outermost may be a fraction). */
  turns: number;
  /** Cable in this layer, m. */
  length: number;
  /** Cable in this layer and every layer inside it, m. */
  through: number;
}

/**
 * The most layers `wind` builds. A typo (a 2.85 km cable, a 0.003 mm cable) would otherwise wind
 * millions of layers inside regen; above this the winding is refused (`tooManyLayers`).
 */
export const MAX_LAYERS = 1000;

/** The winding of a length of cable on a spool. */
export interface Winding {
  /** Cable diameter, m. */
  cable: number;
  /** Cable length on the spool at zero extension, m. */
  length: number;
  core: number;
  width: number;
  /** Turns in a full layer. */
  turnsPerLayer: number;
  /**
   * From the core outward; the last may be partial. Empty when no turn fits the width, or when the
   * length needs more than `MAX_LAYERS` layers.
   */
  layers: WoundLayer[];
  /** The length needs more than `MAX_LAYERS` layers: nothing is wound. */
  tooManyLayers?: true;
}

/** Turns in one layer: floor(width / d). Zero when the cable is wider than the space. */
export function turnsPerLayer(width: number, cable: number): number {
  if (!(cable > 0) || !(width > 0)) return 0;
  // A small tolerance so 20 mm / 2 mm is 10, not 9.999...
  return Math.floor(width / cable + 1e-9);
}

/** Pitch radius of layer n (1 at the core), stacked winding: r_core + d/2 + (n - 1) d. */
export function layerRadius(core: number, cable: number, n: number): number {
  return core / 2 + cable / 2 + (n - 1) * cable;
}

/** The layers `length` of cable makes on `geometry`, from the core outward. */
export function wind(geometry: SpoolGeometry, cable: number, length: number): Winding {
  const n = turnsPerLayer(geometry.width, cable);
  const out: Winding = {
    cable,
    length,
    core: geometry.core,
    width: geometry.width,
    turnsPerLayer: n,
    layers: [],
  };
  if (n === 0 || !(length > 0) || !(geometry.core > 0)) return out;
  let left = length;
  let through = 0;
  for (let k = 1; left > 1e-12; k++) {
    if (k > MAX_LAYERS) {
      out.layers = [];
      out.tooManyLayers = true;
      return out;
    }
    const radius = layerRadius(geometry.core, cable, k);
    const full = n * 2 * Math.PI * radius;
    const here = Math.min(full, left);
    through += here;
    out.layers.push({ n: k, radius, turns: here / (2 * Math.PI * radius), length: here, through });
    left -= here;
  }
  return out;
}

/** Clamp an extension to [0, length]. */
function clamp(w: Winding, extension: number): number {
  return Math.min(Math.max(extension, 0), w.length);
}

/**
 * The layer the cable leaves from at `extension` paid out (clamped to [0, length]), or undefined
 * for a winding with no layers. At zero extension it is the outermost layer; at full payout,
 * layer 1 (its last turn).
 */
export function layerAt(w: Winding, extension: number): WoundLayer | undefined {
  if (w.layers.length === 0) return undefined;
  const wound = w.length - clamp(w, extension);
  // The layer whose span (through - length, through] holds the cable still wound; zero wound
  // means the last turn of layer 1.
  for (const l of w.layers) if (wound <= l.through + 1e-12) return l;
  return w.layers[w.layers.length - 1];
}

/** Layers still holding cable after `paidOut` metres have come off (0 when none is left). */
export function layersWound(w: Winding, paidOut: number): number {
  const wound = w.length - clamp(w, paidOut);
  if (wound <= 1e-12) return 0;
  return layerAt(w, paidOut)?.n ?? 0;
}

/** The effective radius (pitch radius of the layer the cable leaves) at `extension`, m. */
export function effectiveRadius(w: Winding, extension: number): number | undefined {
  return layerAt(w, extension)?.radius;
}

/** The surface of the outermost layer at zero extension, m from the axis. */
export function outerSurface(w: Winding): number | undefined {
  const last = w.layers[w.layers.length - 1];
  return last === undefined ? undefined : last.radius + w.cable / 2;
}

/** The bend ratio D/d. */
export function bendRatio(bendDiameter: number, cable: number): number {
  return bendDiameter / cable;
}

/** What one newton of cable tension and one metre per second of cable speed mean at the spool. */
export interface SpoolPoint {
  extension: number;
  /** The layer the cable leaves from (1 at the core). */
  layer: number;
  /** m: also the spool torque per newton of cable tension (N·m/N). */
  radius: number;
  /** rad/s of spool speed per m/s of cable speed: 1 / r. */
  speedPerCableSpeed: number;
}

/** The spool at one extension: layer, radius, torque and speed ratios. */
export function spoolAt(w: Winding, extension: number): SpoolPoint | undefined {
  const l = layerAt(w, extension);
  if (l === undefined) return undefined;
  return {
    extension: clamp(w, extension),
    layer: l.n,
    radius: l.radius,
    speedPerCableSpeed: 1 / l.radius,
  };
}

/**
 * Radius against extension as steps: each entry is where a layer starts paying out (`from`, m of
 * extension) to where it is empty (`to`), with that layer's radius. Outermost first. What a
 * simulation steps through or a plot draws.
 */
export function radiusSteps(
  w: Winding,
): { from: number; to: number; layer: number; radius: number }[] {
  return [...w.layers].reverse().map((l) => ({
    from: w.length - l.through,
    to: w.length - (l.through - l.length),
    layer: l.n,
    radius: l.radius,
  }));
}
