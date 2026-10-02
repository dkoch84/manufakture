// Every tolerance of the offset engine, in one place (ADR 0014 decision 12; T5.0a spike,
// recommendations 2, 3 and 6). Changing any of them, or the scale, changes the CAM implementation
// version and so misses every cached toolpath.

/** Integer units per millimetre handed to Clipper2: 0.1 micrometre per unit. */
export const CLIPPER_SCALE = 1e4;

/**
 * The largest coordinate magnitude, in integer units, the adapter accepts (4.7 m). clipper2-ts
 * does not range-check `Path64` input, and below this every computation stays on its fast
 * `number` paths.
 */
export const MAX_CLIPPER_COORD = 4.7e7;

/** The same limit in millimetres. */
export const MAX_COORD_MM = MAX_CLIPPER_COORD / CLIPPER_SCALE;

/** Chord error of arc flattening, mm. Flattened vertices lie on the arc. */
export const FLATTEN_TOLERANCE = 0.001;

/** Chord error of Clipper's round joins (`arcTolerance`), mm. Passed explicitly. */
export const JOIN_TOLERANCE = 0.001;

/** Largest distance of a refit line or arc from the offset polyline, mm. */
export const REFIT_TOLERANCE = 0.002;

/**
 * How far offset polyline points may be from a circle their Z tags name and still be refit onto
 * it, mm: flattening plus join chord error plus a margin for integer rounding.
 */
export const TAG_TOLERANCE = FLATTEN_TOLERANCE + JOIN_TOLERANCE + 0.0005;

/** An arc whose sagitta is at most this becomes a line with the same ends, mm (tol / 20). */
export const DEMOTE_SAGITTA = REFIT_TOLERANCE / 20;

/** Decimals the refit's Grbl check rounds to: the default output precision of the posts. */
export const GRBL_CHECK_DECIMALS = 3;

/** Largest sweep of one refit arc, radians: half a turn keeps IJK arcs well conditioned. */
export const MAX_ARC_SWEEP = Math.PI;

/** Circles larger than this radius, mm, are treated as lines by the untagged fit. */
export const MAX_FIT_RADIUS = 1e4;

/**
 * Two segments meeting with tangents closer than this, radians, are tangent: no round join is
 * tagged there, so an arc can run on through the junction.
 */
export const TANGENT_ANGLE = 1e-6;

/** Largest gap allowed between one segment's end and the next one's start in an input, mm. */
export const CONTINUITY_TOLERANCE = 1e-3;

/** Grbl 1.1's radius rule (error 33): absolute and relative limits, and the hard limit, mm. */
export const GRBL_RADIUS_ABS = 0.005;
export const GRBL_RADIUS_REL = 0.001;
export const GRBL_RADIUS_MAX = 0.5;

/** Grbl 1.1's `ARC_ANGULAR_TRAVEL_EPSILON` (config.h), radians. */
export const GRBL_TRAVEL_EPSILON = 5e-7;

/** How far, radians, the travel Grbl computes may be from the intended sweep. */
export const GRBL_TRAVEL_SLACK = 0.5;
