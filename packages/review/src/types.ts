// The review bundle as data (ADR 0016 decision 11; M8 plan "The review bundle and approval"). Plain
// JSON: the app (T8.3b) renders it as untrusted content, as text, so every string, list and image
// here is bounded (`LIMITS`), and `readBundle` checks the bounds again when it is read back.
// Lengths mm, areas mm², volumes mm³, masses g.

export const BUNDLE_FORMAT = 'manufakture-review';
export const BUNDLE_VERSION = 1;

/** The bounds of a bundle. A list cut short says how many it left out. */
export const LIMITS = {
  /** Any text from the document or the agent (names, labels, summaries, messages). */
  text: 500,
  /** A command's JSON, as shown under its summary. */
  commandJson: 4000,
  /** Batches listed (a session has at most 2,000), and commands listed over all of them. */
  batches: 2000,
  commands: 5000,
  /** Features, instances or mates listed per part or assembly, and fields per change. */
  items: 1000,
  fields: 40,
  /** Lines per domain namespace. */
  domainLines: 100,
  /** One script's source, in characters (core allows 256 KiB of UTF-8), and all of them. */
  scriptSource: 262_144,
  scriptsTotal: 4_194_304,
  /** Regen errors and warnings listed per list. */
  errors: 500,
  /** Bodies measured per side, and interference pairs per assembly. */
  bodies: 2000,
  pairs: 1000,
  /** Assemblies checked for interference. */
  assemblies: 32,
  /** Quantity rows compared per list. */
  quantities: 2000,
  /** Views: the four fixed ones and at most four asked for at submit. */
  views: 8,
  /** One image, in bytes. */
  imageBytes: 8 * 1024 * 1024,
  /** Merge preview entries per list. */
  merge: 1000,
} as const;

/** What a bundle is for: the branch's base version and head revision (stale when the head moved). */
export interface BundleKey {
  documentId: string;
  branch: string;
  baseVersion: string;
  headRevision: number;
}

/** A list cut to its limit: `omitted` entries were left out. */
export interface Bounded<T> {
  items: T[];
  omitted: number;
}

// Command diff ----------------------------------------------------------------------------------

export interface CommandSummary {
  type: string;
  /** One readable line ("Added Fillet 3 (2 mm) on 4 edges of Extrude 1"). */
  summary: string;
  /** The command as JSON text, cut at `LIMITS.commandJson` characters. */
  json: string;
  truncated: boolean;
}

export interface BatchDiff {
  /** The branch revision the batch made. */
  revision: number;
  /** `execute` for a batch, `undo` for the inverse of an earlier one. */
  cause: string;
  label: string;
  /** The batch's commands (a `batch` command is listed by its parts). */
  commands: CommandSummary[];
}

// Feature diff ----------------------------------------------------------------------------------

export interface FieldChange {
  /** Dotted path in the object (`extent.distance`, `edges`). */
  path: string;
  before: string;
  after: string;
}

export type ItemChangeKind =
  'added' | 'deleted' | 'edited' | 'renamed' | 'reordered' | 'suppressed' | 'unsuppressed';

/** A feature, instance or mate that changed. */
export interface ItemChange {
  id: string;
  /** The feature kind (`extrude`, `extension:wood.board`), the mate kind, or `instance`. */
  kind: string;
  /** Its name at head (at base when deleted). */
  name: string;
  changes: ItemChangeKind[];
  /** One readable line, as the command summaries read. */
  summary: string;
  /** For `edited`: the fields that differ. */
  fields: FieldChange[];
  /** For `reordered`: position in the list at base and at head (from 1). */
  position?: { before: number; after: number };
}

export interface ContainerDiff {
  /** A part id or an assembly id. */
  id: string;
  name: string;
  change: 'added' | 'deleted' | 'changed';
  /** Fields of the part or assembly itself (name, material, rollback, body props, groups). */
  fields: FieldChange[];
  /** Features of a part; instances, then mates, of an assembly. */
  items: Bounded<ItemChange>;
}

export interface DomainDiff {
  namespace: string;
  change: 'added' | 'removed' | 'changed';
  /**
   * From the namespace's summariser, else a generic list of changed fields; for a domain that owns
   * a typed section (`mech`), the section's lines follow the settings' lines.
   */
  lines: string[];
  omitted: number;
}

export interface ScriptDiff {
  scriptId: string;
  name: string;
  language: string;
  apiVersion: number;
  /** `used`: unchanged, but a feature added or edited in the branch runs it. */
  change: 'added' | 'changed' | 'deleted' | 'used';
  /** The source in full: at head (at base when deleted). */
  source: string;
  /** For `changed`: the source at base. */
  previous?: string;
  /** The source was cut at `LIMITS.scriptSource` or the total. */
  truncated: boolean;
  /** The source holds control or format characters (bidi overrides, zero-width marks). */
  hiddenCharacters: boolean;
  /** The scripted features at head that run it. */
  features: string[];
}

// Renders ---------------------------------------------------------------------------------------

/** A PNG stored as a blob of the document, by SHA-256. */
export interface ImageRef {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ViewPair {
  /** `isometric`, `front`, `top`, `right`, or the name given at submit. */
  name: string;
  /** The camera both images were made with (orthographic, model mm). */
  camera: unknown;
  base: ImageRef | null;
  head: ImageRef | null;
  /** Why an image is missing (nothing to draw, a render error). */
  baseError?: string;
  headError?: string;
  /** For a view of an assembly: which, at what, and what that pose does on each side. */
  assembly?: AssemblyViewInfo;
}

/** An assembly view: the request as asked at submit, and each side's pose read back. */
export interface AssemblyViewInfo {
  assemblyId: string;
  /** Slider distances (mm) and revolute angles (degrees) held, by mate id. */
  mates: Record<string, number>;
  /** Instances placed by hand, by instance id (mm, unit quaternion [x, y, z, w]). */
  poses: Record<string, { translation: number[]; rotation: number[] }>;
  /** Null when that side could not be posed (its error is the image's). */
  base: AssemblyPoseInfo | null;
  head: AssemblyPoseInfo | null;
}

export interface AssemblyPoseInfo {
  /** Each solved mate's coordinates as drawn (mm, degrees). */
  mates: Bounded<{
    mateId: string;
    kind: string;
    coordinates: { name: string; value: number; unit: string }[];
  }>;
  /** What the pose does to the mates (a value past a limit, a pose off its mate), as text. */
  warnings: Bounded<string>;
  /** Instances not drawn: their source failed in the regen. */
  skipped: Bounded<string>;
}

// Regen errors ----------------------------------------------------------------------------------

export interface RegenIssue {
  where: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  partId?: string;
  featureId?: string;
  assemblyId?: string;
  id?: string;
}

export interface RegenIssues {
  /** At head and not at base: errors first. */
  new: Bounded<RegenIssue>;
  /** At both. */
  remaining: Bounded<RegenIssue>;
  /** At base and not at head. */
  resolved: Bounded<RegenIssue>;
  counts: {
    base: { errors: number; warnings: number };
    head: { errors: number; warnings: number };
  };
}

// Measurements ----------------------------------------------------------------------------------

export interface BodyMeasurement {
  volume: number;
  area: number;
  /** Grams, from the body's material (else the part's); null without one. */
  mass: number | null;
  material: string | null;
  boundingBox: { min: number[]; max: number[] } | null;
}

export interface BodyDelta {
  partId: string;
  bodyId: string;
  name: string;
  change: 'added' | 'deleted' | 'changed' | 'unchanged';
  base: BodyMeasurement | null;
  head: BodyMeasurement | null;
  /** Head minus base, for bodies at both. */
  delta: { volume: number; area: number; mass: number | null } | null;
  /** Why it was not measured (a kernel failure), at either side. */
  error?: string;
}

export interface InterferencePair {
  a: string;
  b: string;
  volume: number;
}

export interface AssemblyInterference {
  assemblyId: string;
  name: string;
  /** Overlapping pairs of instances at the poses stored in the document, at base and head. */
  base: InterferencePair[] | null;
  head: InterferencePair[] | null;
  error?: string;
}

// Quantities ------------------------------------------------------------------------------------

export interface QuantityDelta {
  /** `cut list`, `hardware` or `takeoff <part name>`. */
  list: string;
  key: string;
  item: string;
  category: string;
  unit: string;
  base: { quantity: number; extended: number } | null;
  head: { quantity: number; extended: number } | null;
}

export interface QuantityTotalDelta {
  list: string;
  group: string;
  unit: string;
  base: number | null;
  head: number | null;
}

/** One row of a phase list (#1213): its amount at head. */
export interface PhaseRow {
  key: string;
  item: string;
  category: string;
  unit: string;
  quantity: number;
  extended: number;
}

/** One takeoff of a phase at head: its rows and totals. */
export interface PhaseList {
  /** `takeoff <part name>`. */
  list: string;
  rows: Bounded<PhaseRow>;
  totals: { group: string; unit: string; value: number }[];
}

export interface Quantities {
  /** Rows that differ between base and head. */
  rows: Bounded<QuantityDelta>;
  totals: QuantityTotalDelta[];
  /** What could not be counted, at either side. */
  notes: string[];
  /**
   * When the head's construction has phases (#1213): the head's takeoff of new material (what the
   * work adds: what to buy) and of the demolition list (what it takes out), each whole, not a
   * difference. Absent when the head has no phases.
   */
  phases?: { newMaterial: PhaseList[]; demolition: PhaseList[] };
}

// Merge preview ---------------------------------------------------------------------------------

export interface MergePreview {
  /** Whether the preview could be made; when not, `error` says why. */
  ok: boolean;
  error?: string;
  /** Batch labels that apply on Main's current head. */
  applied: Bounded<string>;
  /** Batches that would not apply, with why. */
  dropped: Bounded<{ label: string; message: string }>;
  /** Ids renamed because Main took them meanwhile. */
  renamed: Bounded<{ from: string; to: string }>;
  /** Objects Main changed since the fork that the merge replaces. */
  replaced: Bounded<string>;
  changed: boolean;
}

// The bundle ------------------------------------------------------------------------------------

export interface ReviewBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  key: BundleKey;
  /** The document's name at head. */
  documentName: string;
  commands: { batches: Bounded<BatchDiff>; omittedCommands: number };
  features: { parts: ContainerDiff[]; assemblies: ContainerDiff[] };
  /**
   * Other document-level changes (variables, units, configurations, drawings, CAM, print, user
   * materials).
   */
  document: FieldChange[];
  domains: DomainDiff[];
  scripts: ScriptDiff[];
  renders: ViewPair[];
  regen: RegenIssues;
  measurements: { bodies: Bounded<BodyDelta>; interference: AssemblyInterference[] };
  quantities: Quantities;
  merge: MergePreview | null;
}
