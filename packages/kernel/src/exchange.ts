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
// Reading uses STEPControl_Reader (geometry only). Product names, where a
// caller wants them, are read from the file text by `@manufakture/io`.

import type { TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import type { Oc, Scope } from './occt';

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
  const format = s.own(new oc.TCollection_ExtendedString('MDTV-XCAF'));
  const doc = s.own(new oc.TDocStd_Document(format));
  const app = s.own(oc.XCAFApp_Application.GetApplication());
  app.InitDocument(doc);
  const main = s.own(doc.Main());
  try {
    const tool = s.own(oc.XCAFDoc_DocumentTool.ShapeTool(main));
    for (const body of bodies) {
      // makeAssembly false: a compound body stays one product, not an assembly of its solids.
      const label = s.own(tool.AddShape(body.shape, false, true));
      const name = s.own(new oc.TCollection_ExtendedString(body.name, true));
      s.own(oc.TDataStd_Name.Set(label, name));
    }
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
