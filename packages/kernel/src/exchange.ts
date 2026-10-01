// STEP exchange: write bodies to STEP (AP214) and read a STEP file into one
// shape. OCCT's translators only talk to files, so both go through the
// instance's in-memory Emscripten file system (MEMFS): the bytes are written
// to or read from a scratch file that is removed again at once.
//
// Writing goes through XCAF (STEPCAFControl_Writer) rather than the plain
// STEPControl_Writer, because only XCAF carries a product name per body: each
// body is a top-level shape label with a TDataStd_Name, and becomes a STEP
// PRODUCT of that name. `STEPCAFControl_Writer.Transfer` cannot be used: its
// multi-file argument is bound as std::string, so it can never be null and an
// empty string switches on external references (one file per body). `Perform`
// passes null inside OCCT and writes one self-contained file.
//
// An assembly (`writeStepAssembly`) is the same document with structure: each
// part is a label written once, the assembly a label made with `NewShape`, and
// every instance a component (`AddComponent` with a `TopLoc_Location`) of the
// assembly referring to its part's label. OCCT writes that as one PRODUCT per
// part and a NEXT_ASSEMBLY_USAGE_OCCURRENCE per instance with its placement,
// so a CAD program sees the same part placed twice, not two copies.
//
// Reading uses STEPControl_Reader (geometry only). Product names, where a
// caller wants them, are read from the file text by `@manufakture/io`.

import type { TopoDS_Shape } from 'libcascade/single/init';
import { isObject } from './checks';
import { KernelError } from './errors';
import type { Oc, Scope } from './occt';
import type { Placement } from './types';

let scratch = 0;

/** A path in MEMFS that no other call uses. */
function scratchPath(oc: Oc, ext: string): string {
  const fs = oc.FS;
  try {
    fs.mkdir('/tmp');
  } catch {
    // Already there: Emscripten creates it, and a second call finds it.
  }
  scratch += 1;
  return `/tmp/manufakture-${scratch}.${ext}`;
}

function unlinkQuietly(oc: Oc, path: string): void {
  try {
    oc.FS.unlink(path);
  } catch {
    // The translator never created it.
  }
}

export interface StepBody {
  shape: TopoDS_Shape;
  /** The STEP product name. */
  name: string;
}

/**
 * Write bodies as one AP214 STEP file, one top-level product per body, named.
 * Lengths are in millimetres (OCCT's default `write.step.unit`).
 */
export function writeStep(oc: Oc, s: Scope, bodies: readonly StepBody[]): Uint8Array {
  if (bodies.length === 0) {
    throw new KernelError('exportStep', 'no bodies to export', { code: 'invalid-argument' });
  }
  return writeXcaf(oc, s, (tool) => {
    for (const body of bodies) addBody(oc, s, tool, body);
  });
}

/** An instance's placement in a STEP assembly: the kernel's rigid `Placement`, local to world. */
export type StepPose = Placement;

/**
 * An assembly over a list of bodies (the `exportStep` op's `bodies`): the parts, each written
 * once, and the instances that place them. Parts name their bodies by index in that list.
 */
export interface StepAssemblyLayout {
  /** The assembly's product name. */
  name: string;
  /** Each a product: one body is a plain product, several are a sub-assembly of named bodies. */
  parts: readonly { name: string; bodies: readonly number[] }[];
  /** Each a located component of the assembly, named, referring to a part by index. */
  instances: readonly { part: number; name: string; pose: StepPose }[];
}

/**
 * Write an assembly as one AP214 STEP file: a top-level assembly product of `layout.name`
 * whose components are the instances, each a `NEXT_ASSEMBLY_USAGE_OCCURRENCE` of its part's
 * product with the instance's placement. Each part is written once, however many instances
 * show it. A part of one body is a product of the part's name; a part of several bodies is an
 * assembly of that name with every body a component, a product of the body's name, unmoved.
 * Every body belongs to exactly one part, and every part needs an instance.
 */
export function writeStepAssembly(
  oc: Oc,
  s: Scope,
  bodies: readonly StepBody[],
  layout: StepAssemblyLayout,
): Uint8Array {
  const why = stepAssemblyProblem(layout, bodies.length);
  if (why !== null) throw new KernelError('exportStep', why, { code: 'invalid-argument' });
  return writeXcaf(oc, s, (tool) => {
    const identity = s.own(new oc.TopLoc_Location());
    const parts = layout.parts.map((part) => {
      if (part.bodies.length === 1) {
        return addBody(oc, s, tool, { shape: bodies[part.bodies[0]!]!.shape, name: part.name });
      }
      const label = s.own(tool.NewShape());
      setName(oc, s, label, part.name);
      for (const index of part.bodies) {
        const body = addBody(oc, s, tool, bodies[index]!);
        // The occurrence carries the body's name too, or readers show OCCT's label entry.
        const component = s.own(tool.AddComponent(label, body, identity));
        setName(oc, s, component, bodies[index]!.name);
      }
      return label;
    });
    const root = s.own(tool.NewShape());
    setName(oc, s, root, layout.name);
    for (const instance of layout.instances) {
      const component = s.own(
        tool.AddComponent(root, parts[instance.part]!, location(oc, s, instance.pose)),
      );
      setName(oc, s, component, instance.name);
    }
    // Shapes of assembly labels are compounds of their components: build them now.
    tool.UpdateAssemblies();
  });
}

/** Why `layout` is not an assembly over `count` bodies, or null. */
export function stepAssemblyProblem(layout: StepAssemblyLayout, count: number): string | null {
  if (!isObject(layout)) return 'the assembly must be an object';
  if (!nonEmpty(layout.name)) return 'the assembly needs a name';
  if (!Array.isArray(layout.parts) || layout.parts.length === 0) return 'the assembly has no parts';
  if (!Array.isArray(layout.instances) || layout.instances.length === 0) {
    return 'the assembly has no instances';
  }
  const owner = new Map<number, number>();
  for (const [p, part] of layout.parts.entries()) {
    if (!isObject(part) || !nonEmpty(part.name)) return `part ${p} needs a name`;
    if (!Array.isArray(part.bodies) || part.bodies.length === 0) return `part ${p} has no bodies`;
    for (const b of part.bodies) {
      if (!Number.isInteger(b) || b < 0 || b >= count) {
        return `part ${p} names body ${String(b)}, which is not in the list`;
      }
      if (owner.has(b)) return `body ${b} is in parts ${owner.get(b)} and ${p}`;
      owner.set(b, p);
    }
  }
  if (owner.size !== count) return 'every body must belong to a part';
  const used = new Set<number>();
  for (const [i, instance] of layout.instances.entries()) {
    if (!isObject(instance) || !nonEmpty(instance.name)) return `instance ${i} needs a name`;
    const part = instance.part;
    if (
      typeof part !== 'number' ||
      !Number.isInteger(part) ||
      part < 0 ||
      part >= layout.parts.length
    ) {
      return `instance ${i} names part ${String(part)}, which is not in the list`;
    }
    used.add(part);
    const pose = instance.pose as Partial<StepPose> | undefined;
    const t = pose?.translation;
    const q = pose?.rotation;
    if (
      !Array.isArray(t) ||
      t.length !== 3 ||
      !t.every(Number.isFinite) ||
      !Array.isArray(q) ||
      q.length !== 4 ||
      !q.every(Number.isFinite)
    ) {
      return `instance ${i} needs a pose: a translation [x, y, z] and a rotation [x, y, z, w]`;
    }
    if (Math.abs(Math.hypot(...q) - 1) > 1e-6)
      return `instance ${i}: the rotation is not a unit quaternion`;
  }
  if (used.size !== layout.parts.length) return 'every part needs an instance';
  return null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

type ShapeTool = ReturnType<Oc['XCAFDoc_DocumentTool']['ShapeTool']>;
type Label = ReturnType<ShapeTool['NewShape']>;

/**
 * An XCAF document filled by `fill`, written with `STEPCAFControl_Writer.Perform` (see the
 * file comment) to a scratch file and read back as bytes.
 */
function writeXcaf(oc: Oc, s: Scope, fill: (tool: ShapeTool) => void): Uint8Array {
  const format = s.own(new oc.TCollection_ExtendedString('MDTV-XCAF'));
  const doc = s.own(new oc.TDocStd_Document(format));
  const app = s.own(oc.XCAFApp_Application.GetApplication());
  app.InitDocument(doc);
  const main = s.own(doc.Main());
  try {
    fill(s.own(oc.XCAFDoc_DocumentTool.ShapeTool(main)));
    const path = scratchPath(oc, 'step');
    try {
      const writer = s.own(new oc.STEPCAFControl_Writer());
      const progress = s.own(new oc.Message_ProgressRange());
      if (!writer.Perform(doc, path, progress)) throw new Error('the STEP writer failed');
      return oc.FS.readFile(path);
    } finally {
      unlinkQuietly(oc, path);
    }
  } finally {
    // The document's attributes hold the shapes; drop them before the wrappers go.
    const root = s.own(main.Root());
    root.ForgetAllAttributes(true);
  }
}

/** A body as a top-level shape label with its name. */
function addBody(oc: Oc, s: Scope, tool: ShapeTool, body: StepBody): Label {
  // makeAssembly false: a compound body stays one product, not an assembly of its solids.
  const label = s.own(tool.AddShape(body.shape, false, true));
  setName(oc, s, label, body.name);
  return label;
}

function setName(oc: Oc, s: Scope, label: Label, name: string): void {
  const text = s.own(new oc.TCollection_ExtendedString(name, true));
  s.own(oc.TDataStd_Name.Set(label, text));
}

function location(oc: Oc, s: Scope, pose: StepPose) {
  const [x, y, z, w] = pose.rotation;
  const n = Math.hypot(x, y, z, w);
  const trsf = s.own(new oc.gp_Trsf());
  // SetRotation clears the translation, so it goes first.
  trsf.SetRotation(s.own(new oc.gp_Quaternion(x / n, y / n, z / n, w / n)));
  const [tx, ty, tz] = pose.translation;
  trsf.SetTranslationPart(s.own(new oc.gp_Vec(tx, ty, tz)));
  return s.own(new oc.TopLoc_Location(trsf));
}

/**
 * Largest STEP file the kernel reads. The app keeps imports under 20 MB (they live in the
 * document); this bounds what any caller of the op can make the worker's memory file system and
 * OCCT's reader hold.
 */
export const MAX_STEP_BYTES = 64 * 1024 * 1024;

/**
 * Read a STEP file into one shape (a compound when the file has several
 * roots). OCCT converts lengths to millimetres. The caller owns the result.
 * A file that is empty, too large, not STEP or has no shapes is an
 * `invalid-argument` error; the reader's session is cleared on every path.
 */
export function readStep(oc: Oc, s: Scope, bytes: Uint8Array): TopoDS_Shape {
  if (bytes.length === 0) {
    throw new KernelError('importStep', 'the STEP file is empty', { code: 'invalid-argument' });
  }
  if (bytes.length > MAX_STEP_BYTES) {
    throw new KernelError(
      'importStep',
      `the STEP file is ${bytes.length} bytes; the limit is ${MAX_STEP_BYTES}`,
      { code: 'invalid-argument' },
    );
  }
  const path = scratchPath(oc, 'step');
  const reader = s.own(new oc.STEPControl_Reader());
  try {
    // Inside the try: a write that fails part way (MEMFS out of memory) still
    // has its scratch file removed.
    oc.FS.writeFile(path, bytes);
    const status = reader.ReadFile(path);
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new KernelError('importStep', `this is not a readable STEP file (${status})`, {
        code: 'invalid-argument',
      });
    }
    const progress = s.own(new oc.Message_ProgressRange());
    const roots = reader.TransferRoots(progress);
    if (roots === 0) {
      throw new KernelError('importStep', 'the STEP file has no shapes', {
        code: 'invalid-argument',
      });
    }
    const shape = reader.OneShape();
    if (shape.IsNull()) {
      shape.delete();
      throw new KernelError('importStep', 'the STEP file has no shapes', {
        code: 'invalid-argument',
      });
    }
    return shape;
  } finally {
    // The reader's work session holds the model and the transfer results, whatever happened.
    unlinkQuietly(oc, path);
    try {
      reader.ClearShapes();
      s.own(reader.WS()).ClearData(1);
    } catch {
      // A reader that failed before it had a session has nothing to clear.
    }
  }
}

/** Decode base64 (the document stores imported files as base64 text). */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
