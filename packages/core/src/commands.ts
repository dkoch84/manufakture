import { isValidVariableName } from '@manufakture/units';
import { z } from 'zod';
import {
  bodyCreator,
  dimensionInstances,
  drawingExpressions,
  explodedViewExpressions,
  explodedViewIds,
  featureDependencies,
  featureExpressions,
  featureSubIds,
  forEachView,
  instanceExplodedViews,
  instanceMates,
  instancePart,
  isPinnedSource,
  mateExpressions,
  mateIds,
  printItemIds,
  printSetupExpressions,
  printSetupIds,
  sheetIds,
} from './features';
import { PART_COUNTER, parseAnyId, peekCounter } from './ids';
import { fail, ok, schemaError, type CoreResult } from './result';
import {
  ASSEMBLY_COUNTER,
  ASSEMBLY_ID_PATTERN,
  AssemblySchema,
  BodyIdSchema,
  BodyPropsFieldsSchema,
  CONFIG_PARAMETER_COUNTER,
  CONFIG_ROW_COUNTER,
  ConfigParameterIdSchema,
  ConfigParameterSchema,
  ConfigRowIdSchema,
  ConfigRowSchema,
  DRAWING_COUNTER,
  DRAWING_ID_PATTERN,
  DimensionSchema,
  DisplayUnitsSchema,
  DocumentSchema,
  DrawingSchema,
  ExplodeStepSchema,
  ExplodedViewSchema,
  DomainDataSchema,
  DomainNamespaceSchema,
  FONT_COUNTER,
  FONT_ID_PATTERN,
  FeatureSchema,
  FontIdSchema,
  FontSchema,
  InstanceSchema,
  InstanceSourceSchema,
  MateSchema,
  MAX_ASSEMBLY_ITEMS,
  MAX_DOMAINS,
  MAX_DRAWING_ITEMS,
  MAX_FONT_TOTAL_BYTES,
  MAX_INSTANCE_NAME,
  MaterialIdSchema,
  NoteSchema,
  PaperPointSchema,
  PartSchema,
  PoseSchema,
  PrintItemSchema,
  PrintSetupSchema,
  PrintThresholdsSchema,
  PrinterIdSchema,
  SheetSchema,
  SheetSizeSchema,
  StoredExpressionSchema,
  TitleBlockSchema,
  ViewSchema,
  fontBytes,
  type Assembly,
  type BodyProps,
  type BodyPropsFields,
  type ConfigParameter,
  type ConfigRow,
  type Configurations,
  type Dimension,
  type DocumentFont,
  type DomainData,
  type Drawing,
  type DrawingView,
  type ExplodeStep,
  type ExplodedView,
  type Feature,
  type Instance,
  type ManufaktureDocument,
  type Mate,
  type Part,
  type Pose,
  type PrintData,
  type PrintItem,
  type PrintSetup,
  type Sheet,
  type Note,
} from './schema';
import { createAssembly, createPart } from './document';
import { checkDocument, expressionVariableNames } from './validate';

/**
 * Commands: every change to a document is one of these plain, serializable objects. Applying a
 * command returns the new document and the command that undoes it, so a history of commands is
 * both the undo stack and an op log (M2 version history, M7 sync). Commands never mutate their
 * input document.
 */

/** Longest document name `renameDocument` accepts. */
export const MAX_DOCUMENT_NAME = 200;
/** Longest part studio name `addPart`, `renamePart` and `duplicatePart` accept. */
export const MAX_PART_NAME = 200;
/** A part id straight from the document counter: `part#n`. */
export const PART_ID_PATTERN = /^part#[1-9][0-9]*$/;
/** Longest assembly name `addAssembly` and `renameAssembly` accept. */
export const MAX_ASSEMBLY_NAME = 200;
/** Longest print setup name `editPrintSetup` accepts (as for features). */
export const MAX_PRINT_SETUP_NAME = 200;

const partId = z.string().min(1);
const assemblyId = z.string().min(1).max(32);
const instanceId = z.string().min(1).max(32);
const mateId = z.string().min(1).max(32);
const featureId = z.string().min(1);
const setupId = z.string().min(1).max(32);
const itemId = z.string().min(1).max(32);
const drawingId = z.string().min(1).max(32);
const sheetId = z.string().min(1).max(32);
const viewId = z.string().min(1).max(32);
const dimensionId = z.string().min(1).max(32);
const noteId = z.string().min(1).max(32);
const explodedViewId = z.string().min(1).max(32);
const stepId = z.string().min(1).max(32);
const index = z.int().min(0);

export const SimpleCommandSchema = z.discriminatedUnion('type', [
  /**
   * Insert a new feature. Its ids must be fresh and cannot be split pieces; `index` defaults to
   * the rollback bar.
   */
  z.strictObject({
    type: z.literal('addFeature'),
    partId,
    feature: FeatureSchema,
    index: index.optional(),
  }),
  /**
   * Replace a feature's inputs. Same id and kind; ids it introduces must be fresh, and a split
   * piece must split an id this feature had before and no longer has.
   */
  z.strictObject({ type: z.literal('editFeature'), partId, feature: FeatureSchema }),
  /** Remove a feature. Refused while another feature depends on it. */
  z.strictObject({ type: z.literal('deleteFeature'), partId, featureId }),
  /**
   * Put an earlier state of a feature back (undo of a delete or an edit, and redo of an add).
   * Replaces the feature with the same id, or inserts it at `index`, and sets the rollback bar.
   * Unlike `addFeature` and `editFeature`, its ids must have been allocated before.
   *
   * History only: it is the inverse that undo and redo apply, and it checks only that each id
   * was allocated at some point, not that a split piece is fresh. Clients editing a feature use
   * `editFeature`, which enforces the full id rules.
   */
  z.strictObject({
    type: z.literal('restoreFeature'),
    partId,
    feature: FeatureSchema,
    index,
    rollbackIndex: index.nullable(),
  }),
  /** Move a feature so it ends up at `index`. Refused if it would pass a dependency. */
  z.strictObject({ type: z.literal('reorderFeature'), partId, featureId, index }),
  z.strictObject({
    type: z.literal('suppressFeature'),
    partId,
    featureId,
    suppressed: z.boolean(),
  }),
  z.strictObject({ type: z.literal('renameFeature'), partId, featureId, name: z.string() }),
  /** Set what the part's body is made of (a built-in material id), or clear it with `null`. */
  z.strictObject({
    type: z.literal('setMaterial'),
    partId,
    material: MaterialIdSchema.nullable(),
  }),
  /**
   * Set a body's name, colour and material, all at once: `props` replaces the body's entry, and
   * empty `props` removes it. `index` places a new entry (default: last); ignored on update.
   */
  z.strictObject({
    type: z.literal('setBodyProps'),
    partId,
    bodyId: BodyIdSchema,
    props: BodyPropsFieldsSchema,
    index: index.optional(),
  }),
  /** Move the rollback bar; `null` puts it after the last feature. */
  z.strictObject({ type: z.literal('setRollback'), partId, index: index.nullable() }),
  /** Create or update a variable. `index` places a new one (default: last); ignored on update. */
  z.strictObject({
    type: z.literal('setVariable'),
    name: z.string(),
    expression: StoredExpressionSchema,
    index: index.optional(),
  }),
  /** Remove a variable. Refused while a variable or feature references it. */
  z.strictObject({ type: z.literal('deleteVariable'), name: z.string() }),
  /** Change display units. Stored expressions keep their own units, so no geometry changes. */
  z.strictObject({ type: z.literal('setDisplayUnits'), units: DisplayUnitsSchema }),
  /** Rename the document (trimmed, 1 to 200 characters). */
  z.strictObject({ type: z.literal('renameDocument'), name: z.string() }),
  /**
   * Create or replace a configuration parameter, by id. A new one needs a fresh `cp#n` id and
   * goes at `index` (default: last); `index` is ignored on replace.
   */
  z.strictObject({
    type: z.literal('setConfigParameter'),
    parameter: ConfigParameterSchema,
    index: index.optional(),
  }),
  /** Remove a configuration parameter and every row's value for it. */
  z.strictObject({
    type: z.literal('deleteConfigParameter'),
    parameterId: ConfigParameterIdSchema,
  }),
  /** History only: put a deleted parameter back at `index` (its id was allocated before). */
  z.strictObject({
    type: z.literal('restoreConfigParameter'),
    parameter: ConfigParameterSchema,
    index,
  }),
  /**
   * Create or replace a configuration row, by id. A new one needs a fresh `cfg#n` id and goes
   * at `index` (default: last); `index` is ignored on replace.
   */
  z.strictObject({
    type: z.literal('setConfigRow'),
    row: ConfigRowSchema,
    index: index.optional(),
  }),
  /** Remove a configuration row. Deleting the active row leaves no row active. */
  z.strictObject({ type: z.literal('deleteConfigRow'), rowId: ConfigRowIdSchema }),
  /** History only: put a deleted row back at `index` (its id was allocated before). */
  z.strictObject({ type: z.literal('restoreConfigRow'), row: ConfigRowSchema, index }),
  /** Choose the row the document is shown and built in; `null`: none. */
  z.strictObject({
    type: z.literal('setActiveConfiguration'),
    rowId: ConfigRowIdSchema.nullable(),
  }),
  /**
   * Add an empty part studio. `partId` must be a fresh `part#n` from the document's
   * `nextIds.part`; it goes at `index` (default: last).
   */
  z.strictObject({
    type: z.literal('addPart'),
    partId,
    name: z.string(),
    index: index.optional(),
  }),
  /** Rename a part studio (trimmed, 1 to 200 characters). */
  z.strictObject({ type: z.literal('renamePart'), partId, name: z.string() }),
  /**
   * Remove a part studio. Refused for the last one, while a configuration parameter
   * suppresses one of its features, while an assembly instance shows it, and while a print item
   * prints it.
   */
  z.strictObject({ type: z.literal('deletePart'), partId }),
  /**
   * History only: put a deleted part studio back at `index` (undo of a delete, redo of an add
   * or a duplicate). Its id must have been allocated before; the counter does not move.
   */
  z.strictObject({ type: z.literal('restorePart'), part: PartSchema, index }),
  /** Move a part studio so it ends up at `index`. */
  z.strictObject({ type: z.literal('reorderParts'), partId, index }),
  /**
   * Copy part studio `sourcePartId` to a new one, `partId` (a fresh `part#n`), at `index`
   * (default: just after the source). Features keep their ids, since ids are per part; body
   * names, colours and materials, the rollback bar and the counters are copied too.
   */
  z.strictObject({
    type: z.literal('duplicatePart'),
    sourcePartId: partId,
    partId,
    name: z.string(),
    index: index.optional(),
  }),
  /**
   * Add an empty assembly. `assemblyId` must be a fresh `assembly#n` from the document's
   * `nextIds.assembly`; it goes at `index` (default: last).
   */
  z.strictObject({
    type: z.literal('addAssembly'),
    assemblyId,
    name: z.string(),
    index: index.optional(),
  }),
  /** Rename an assembly (trimmed, 1 to 200 characters). */
  z.strictObject({ type: z.literal('renameAssembly'), assemblyId, name: z.string() }),
  /** Remove an assembly with its instances and mates. Nothing else refers to an assembly. */
  z.strictObject({ type: z.literal('deleteAssembly'), assemblyId }),
  /** History only: put a deleted assembly back at `index` (its id was allocated before). */
  z.strictObject({ type: z.literal('restoreAssembly'), assembly: AssemblySchema, index }),
  /**
   * Add an instance, last. Its id must be a fresh `inst#n` from the assembly's `nextIds.inst`;
   * a part of this document must exist.
   */
  z.strictObject({ type: z.literal('addInstance'), assemblyId, instance: InstanceSchema }),
  /**
   * Change an instance's name, `fixed`, `suppressed`, shown `bodies` (`null`: every body) or
   * `source` (another part or pin, or another configuration row). Absent fields stay.
   */
  z.strictObject({
    type: z.literal('editInstance'),
    assemblyId,
    instanceId,
    name: z.string().exactOptional(),
    fixed: z.boolean().exactOptional(),
    suppressed: z.boolean().exactOptional(),
    bodies: InstanceSchema.shape.bodies.unwrap().nullable().exactOptional(),
    source: InstanceSourceSchema.exactOptional(),
  }),
  /**
   * Set the poses of several instances at once, by instance id: one undo step for a solve or a
   * drag. Commit on drag end and after mate edits, never per frame.
   */
  z.strictObject({
    type: z.literal('setPoses'),
    assemblyId,
    poses: z.record(instanceId, PoseSchema),
  }),
  /** Remove an instance. Refused while a mate connects it. */
  z.strictObject({ type: z.literal('deleteInstance'), assemblyId, instanceId }),
  /** History only: put a deleted instance back at `index` (its id was allocated before). */
  z.strictObject({
    type: z.literal('restoreInstance'),
    assemblyId,
    instance: InstanceSchema,
    index,
  }),
  /**
   * Add a mate, last (the newest). Its id, its connectors' ids and their references' ids must be
   * fresh (`mate#n`, `mc#n`, `r<n>` from the assembly's `nextIds`).
   */
  z.strictObject({ type: z.literal('addMate'), assemblyId, mate: MateSchema }),
  /** Replace a mate's inputs, by id. Ids it introduces must be fresh. */
  z.strictObject({ type: z.literal('editMate'), assemblyId, mate: MateSchema }),
  /** Remove a mate with its connectors. */
  z.strictObject({ type: z.literal('deleteMate'), assemblyId, mateId }),
  /**
   * History only: put a mate state back, replacing the mate with the same id (at `index`) or
   * inserting it at `index`. Its ids must have been allocated before.
   */
  z.strictObject({ type: z.literal('restoreMate'), assemblyId, mate: MateSchema, index }),
  z.strictObject({
    type: z.literal('suppressMate'),
    assemblyId,
    mateId,
    suppressed: z.boolean(),
  }),
  /**
   * Add a print setup at `index` (default: last). Its id, its items' ids and their references'
   * ids must be fresh (`print#n`, `item#n`, `r<n>` from `print.nextIds`). Since version 8.
   */
  z.strictObject({
    type: z.literal('addPrintSetup'),
    setup: PrintSetupSchema,
    index: index.optional(),
  }),
  /**
   * Change a setup's name, printer, nozzle or thresholds (`null`: the defaults). Absent fields
   * stay. Items are edited with the item commands.
   */
  z.strictObject({
    type: z.literal('editPrintSetup'),
    setupId,
    name: z.string().exactOptional(),
    printer: PrinterIdSchema.exactOptional(),
    nozzle: PrintSetupSchema.shape.nozzle.exactOptional(),
    thresholds: PrintThresholdsSchema.nullable().exactOptional(),
  }),
  /** Remove a print setup with its items. Nothing refers to a setup. */
  z.strictObject({ type: z.literal('deletePrintSetup'), setupId }),
  /** History only: put a deleted setup back at `index` (its ids were allocated before). */
  z.strictObject({ type: z.literal('restorePrintSetup'), setup: PrintSetupSchema, index }),
  /**
   * Add an item to a setup at `index` (default: last). Its id and its face reference's id must be
   * fresh (`item#n`, `r<n>` from `print.nextIds`); the part must exist. The body and face are not
   * checked against the part: what they name may change or go, and the print workspace reports it.
   */
  z.strictObject({
    type: z.literal('addPrintItem'),
    setupId,
    item: PrintItemSchema,
    index: index.optional(),
  }),
  /** Replace an item's inputs, by id. Ids it introduces must be fresh. */
  z.strictObject({ type: z.literal('editPrintItem'), setupId, item: PrintItemSchema }),
  /** Remove an item from a setup. */
  z.strictObject({ type: z.literal('deletePrintItem'), setupId, itemId }),
  /**
   * History only: put an item state back, replacing the item with the same id (at `index`) or
   * inserting it at `index`. Its ids must have been allocated before.
   */
  z.strictObject({ type: z.literal('restorePrintItem'), setupId, item: PrintItemSchema, index }),
  /**
   * Add a font at `index` (default: last). Its id must be a fresh `font#n` from the document's
   * `nextIds.font`; a font with the same bytes (SHA-256) may not be added twice. Since version 9.
   */
  z.strictObject({ type: z.literal('addFont'), font: FontSchema, index: index.optional() }),
  /** Remove a font. Refused while an outline of any sketch uses it. */
  z.strictObject({ type: z.literal('deleteFont'), fontId: FontIdSchema }),
  /** History only: put a deleted font back at `index` (its id was allocated before). */
  z.strictObject({ type: z.literal('restoreFont'), font: FontSchema, index }),
  /**
   * Replace a domain's document-level data (ADR 0013 decision 3): `schemaVersion` and `data`
   * together set the namespace's entry; both absent remove it. Core never looks inside `data`;
   * the domain package validates it before issuing the command. The inverse sets the old entry
   * back, or removes the namespace when it had none. Since version 11.
   */
  z
    .strictObject({
      type: z.literal('setDomainData'),
      namespace: DomainNamespaceSchema,
      schemaVersion: DomainDataSchema.shape.schemaVersion.exactOptional(),
      data: DomainDataSchema.shape.data.exactOptional(),
    })
    .check((ctx) => {
      if ('schemaVersion' in ctx.value !== 'data' in ctx.value) {
        ctx.issues.push({
          code: 'custom',
          message:
            'give both "schemaVersion" and "data" to set domain data, or neither to remove it',
          input: ctx.value,
        });
      }
    }),
  /**
   * Add an exploded view to an assembly at `index` (default: last). Its id and its steps' ids must
   * be fresh (`explode#n`, `step#n` from the assembly's `nextIds`). Since version 12.
   */
  z.strictObject({
    type: z.literal('addExplodedView'),
    assemblyId,
    explodedView: ExplodedViewSchema,
    index: index.optional(),
  }),
  /**
   * Replace an exploded view's name and steps, by id: renaming it, and adding, editing, removing
   * or reordering steps in one go. Ids it introduces must be fresh.
   */
  z.strictObject({
    type: z.literal('editExplodedView'),
    assemblyId,
    explodedView: ExplodedViewSchema,
  }),
  /** Remove an exploded view with its steps. Refused while a drawing view shows it. */
  z.strictObject({ type: z.literal('deleteExplodedView'), assemblyId, explodedViewId }),
  /**
   * History only: put an exploded view state back, replacing the one with the same id (at
   * `index`) or inserting it at `index`. Its ids must have been allocated before.
   */
  z.strictObject({
    type: z.literal('restoreExplodedView'),
    assemblyId,
    explodedView: ExplodedViewSchema,
    index,
  }),
  /** Add a step to an exploded view at `index` (default: last). Its id must be a fresh `step#n`. */
  z.strictObject({
    type: z.literal('addExplodeStep'),
    assemblyId,
    explodedViewId,
    step: ExplodeStepSchema,
    index: index.optional(),
  }),
  /** Replace a step's instances, direction and distance, by id. */
  z.strictObject({
    type: z.literal('editExplodeStep'),
    assemblyId,
    explodedViewId,
    step: ExplodeStepSchema,
  }),
  /** Remove a step. Nothing refers to a step. */
  z.strictObject({ type: z.literal('deleteExplodeStep'), assemblyId, explodedViewId, stepId }),
  /** History only: put a step state back (replace by id at `index`, or insert at `index`). */
  z.strictObject({
    type: z.literal('restoreExplodeStep'),
    assemblyId,
    explodedViewId,
    step: ExplodeStepSchema,
    index,
  }),
  /**
   * Add a drawing at `index` (default: last). Its id must be a fresh `drawing#n` from the
   * document's `nextIds.drawing`; the ids inside it must be allocated by its own `nextIds`.
   * Since version 12.
   */
  z.strictObject({
    type: z.literal('addDrawing'),
    drawing: DrawingSchema,
    index: index.optional(),
  }),
  /** Rename a drawing (trimmed, 1 to 200 characters). */
  z.strictObject({ type: z.literal('renameDrawing'), drawingId, name: z.string() }),
  /** Remove a drawing with its sheets. Nothing refers to a drawing. */
  z.strictObject({ type: z.literal('deleteDrawing'), drawingId }),
  /** History only: put a deleted drawing back at `index` (its id was allocated before). */
  z.strictObject({ type: z.literal('restoreDrawing'), drawing: DrawingSchema, index }),
  /** Move a drawing so it ends up at `index`. */
  z.strictObject({ type: z.literal('reorderDrawings'), drawingId, index }),
  /**
   * Add a sheet to a drawing at `index` (default: last). Its id and the ids of its views,
   * dimensions and notes must be fresh (`sheet#n`, `view#n`, `dim#n`, `note#n` from the drawing's
   * `nextIds`).
   */
  z.strictObject({
    type: z.literal('addSheet'),
    drawingId,
    sheet: SheetSchema,
    index: index.optional(),
  }),
  /**
   * Change a sheet's name, size, orientation or title block (`null`: none). Absent fields stay.
   * Views, dimensions and notes are edited with their own commands.
   */
  z.strictObject({
    type: z.literal('editSheet'),
    drawingId,
    sheetId,
    name: z.string().exactOptional(),
    size: SheetSizeSchema.exactOptional(),
    orientation: SheetSchema.shape.orientation.exactOptional(),
    titleBlock: TitleBlockSchema.nullable().exactOptional(),
  }),
  /**
   * Remove a sheet with its views, dimensions and notes. Nothing outside the sheet refers to it.
   */
  z.strictObject({ type: z.literal('deleteSheet'), drawingId, sheetId }),
  /** History only: put a deleted sheet back at `index` (its ids were allocated before). */
  z.strictObject({ type: z.literal('restoreSheet'), drawingId, sheet: SheetSchema, index }),
  /** Move a sheet so it ends up at `index`. */
  z.strictObject({ type: z.literal('reorderSheets'), drawingId, sheetId, index }),
  /**
   * Add a view to a sheet at `index` (default: last). Its id must be a fresh `view#n` from the
   * drawing's `nextIds`; the part, assembly or exploded view it shows must exist.
   */
  z.strictObject({
    type: z.literal('addView'),
    drawingId,
    sheetId,
    view: ViewSchema,
    index: index.optional(),
  }),
  /** Replace a view's inputs, by id (source, direction, scale, position, options, label). */
  z.strictObject({ type: z.literal('editView'), drawingId, sheetId, view: ViewSchema }),
  /** Move a view on its sheet (a drag): set its `position` only. */
  z.strictObject({
    type: z.literal('moveView'),
    drawingId,
    sheetId,
    viewId,
    position: PaperPointSchema,
  }),
  /** Remove a view. Refused while a dimension or note on the sheet is in it. */
  z.strictObject({ type: z.literal('deleteView'), drawingId, sheetId, viewId }),
  /** History only: put a view state back (replace by id at `index`, or insert at `index`). */
  z.strictObject({
    type: z.literal('restoreView'),
    drawingId,
    sheetId,
    view: ViewSchema,
    index,
  }),
  /**
   * Add a dimension to a sheet at `index` (default: last). Its id must be a fresh `dim#n` from
   * the drawing's `nextIds`; its view must be on the sheet. Its model references are not checked
   * against the model: what they name may change or go, and regen reports it.
   */
  z.strictObject({
    type: z.literal('addDimension'),
    drawingId,
    sheetId,
    dimension: DimensionSchema,
    index: index.optional(),
  }),
  /** Replace a dimension's inputs, by id (a re-pick, a drag of its placement, a text override). */
  z.strictObject({
    type: z.literal('editDimension'),
    drawingId,
    sheetId,
    dimension: DimensionSchema,
  }),
  z.strictObject({ type: z.literal('deleteDimension'), drawingId, sheetId, dimensionId }),
  /** History only: put a dimension state back (replace by id at `index`, or insert at `index`). */
  z.strictObject({
    type: z.literal('restoreDimension'),
    drawingId,
    sheetId,
    dimension: DimensionSchema,
    index,
  }),
  /** Add a note to a sheet at `index` (default: last). Its id must be a fresh `note#n`. */
  z.strictObject({
    type: z.literal('addNote'),
    drawingId,
    sheetId,
    note: NoteSchema,
    index: index.optional(),
  }),
  /** Replace a note's text, position or view, by id. */
  z.strictObject({ type: z.literal('editNote'), drawingId, sheetId, note: NoteSchema }),
  z.strictObject({ type: z.literal('deleteNote'), drawingId, sheetId, noteId }),
  /** History only: put a note state back (replace by id at `index`, or insert at `index`). */
  z.strictObject({ type: z.literal('restoreNote'), drawingId, sheetId, note: NoteSchema, index }),
  /**
   * History only: put a whole document in place of this one (restore a version or revision; the
   * undo of a restore). The replacement must be this document (same `id`) and valid as a whole,
   * assemblies and configurations included. Its inverse is `replaceDocument` of the document it
   * replaced. Clients restoring an older state build the replacement with `restoredDocument`,
   * which keeps the id counters from going back.
   */
  z.strictObject({ type: z.literal('replaceDocument'), document: DocumentSchema }),
]);

export type SimpleCommand = z.infer<typeof SimpleCommandSchema>;
/** Several commands applied as one: all or nothing, one undo step. */
export interface BatchCommand {
  type: 'batch';
  commands: Command[];
}
export type Command = SimpleCommand | BatchCommand;
export type CommandType = Command['type'];

export const CommandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([
    SimpleCommandSchema,
    z.strictObject({ type: z.literal('batch'), commands: z.array(CommandSchema).min(1) }),
  ]),
);

export interface Applied {
  readonly document: ManufaktureDocument;
  /** Applying this to `document` gives back the original document. */
  readonly inverse: Command;
}

/**
 * Applies a command. The command is validated against its schema first (so commands read back
 * from an op log are safe), and the resulting document must pass `checkDocument`; otherwise the
 * error is returned and nothing changes.
 */
export function applyCommand(doc: ManufaktureDocument, command: Command): CoreResult<Applied> {
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, error: schemaError('Invalid command', parsed.error) };
  const applied = applyUnchecked(doc, parsed.data);
  if (!applied.ok) return applied;
  const checked = checkDocument(applied.value.document);
  if (!checked.ok) return checked;
  return applied;
}

function applyUnchecked(doc: ManufaktureDocument, command: Command): CoreResult<Applied> {
  switch (command.type) {
    case 'batch': {
      let current = doc;
      const inverses: Command[] = [];
      for (const c of command.commands) {
        const r = applyUnchecked(current, c);
        if (!r.ok) return r;
        current = r.value.document;
        inverses.push(r.value.inverse);
      }
      return ok({ document: current, inverse: { type: 'batch', commands: inverses.reverse() } });
    }
    case 'setVariable':
      return setVariable(doc, command);
    case 'deleteVariable':
      return deleteVariable(doc, command.name);
    case 'setDisplayUnits':
      return ok({
        document: { ...doc, units: command.units },
        inverse: { type: 'setDisplayUnits', units: doc.units },
      });
    case 'setDomainData':
      return setDomainData(doc, command);
    case 'replaceDocument': {
      const next = command.document;
      if (next.id !== doc.id) {
        return fail('invalid-id', `The replacement is document "${next.id}", not "${doc.id}"`, [
          'document',
          'id',
        ]);
      }
      return ok({ document: next, inverse: { type: 'replaceDocument', document: doc } });
    }
    case 'renameDocument': {
      const name = command.name.trim();
      if (name.length === 0 || name.length > MAX_DOCUMENT_NAME) {
        return fail(
          'invalid-name',
          `A document name must be 1 to ${MAX_DOCUMENT_NAME} characters`,
          ['name'],
        );
      }
      return ok({
        document: name === doc.name ? doc : { ...doc, name },
        inverse: { type: 'renameDocument', name: doc.name },
      });
    }
    case 'setConfigParameter':
    case 'deleteConfigParameter':
    case 'restoreConfigParameter':
    case 'setConfigRow':
    case 'deleteConfigRow':
    case 'restoreConfigRow':
    case 'setActiveConfiguration':
      return applyToConfigurations(doc, command);
    case 'addPart':
    case 'renamePart':
    case 'deletePart':
    case 'restorePart':
    case 'reorderParts':
    case 'duplicatePart':
      return applyToParts(doc, command);
    case 'addAssembly':
    case 'renameAssembly':
    case 'deleteAssembly':
    case 'restoreAssembly':
      return applyToAssemblies(doc, command);
    case 'addInstance':
    case 'editInstance':
    case 'setPoses':
    case 'deleteInstance':
    case 'restoreInstance':
    case 'addMate':
    case 'editMate':
    case 'deleteMate':
    case 'restoreMate':
    case 'suppressMate':
    case 'addExplodedView':
    case 'editExplodedView':
    case 'deleteExplodedView':
    case 'restoreExplodedView':
    case 'addExplodeStep':
    case 'editExplodeStep':
    case 'deleteExplodeStep':
    case 'restoreExplodeStep':
      return applyToAssembly(doc, command);
    case 'addDrawing':
    case 'renameDrawing':
    case 'deleteDrawing':
    case 'restoreDrawing':
    case 'reorderDrawings':
    case 'addSheet':
    case 'editSheet':
    case 'deleteSheet':
    case 'restoreSheet':
    case 'reorderSheets':
    case 'addView':
    case 'editView':
    case 'moveView':
    case 'deleteView':
    case 'restoreView':
    case 'addDimension':
    case 'editDimension':
    case 'deleteDimension':
    case 'restoreDimension':
    case 'addNote':
    case 'editNote':
    case 'deleteNote':
    case 'restoreNote':
      return applyToDrawings(doc, command);
    case 'addPrintSetup':
    case 'editPrintSetup':
    case 'deletePrintSetup':
    case 'restorePrintSetup':
    case 'addPrintItem':
    case 'editPrintItem':
    case 'deletePrintItem':
    case 'restorePrintItem':
      return applyToPrint(doc, command);
    case 'addFont':
    case 'deleteFont':
    case 'restoreFont':
      return applyToFonts(doc, command);
    default:
      return applyToPart(doc, command);
  }
}

type SetDomainDataCommand = Extract<SimpleCommand, { type: 'setDomainData' }>;

/** The `setDomainData` that puts a namespace's entry back as it is in `doc` (or removes it). */
function domainDataCommand(doc: ManufaktureDocument, namespace: string): SetDomainDataCommand {
  const old = Object.hasOwn(doc.domains ?? {}, namespace) ? doc.domains![namespace] : undefined;
  return old === undefined
    ? { type: 'setDomainData', namespace }
    : { type: 'setDomainData', namespace, schemaVersion: old.schemaVersion, data: old.data };
}

/**
 * Sets or removes one namespace's entry in `domains`. Removing the last entry drops `domains`
 * itself, so a document that never had domain data and one whose entries were all removed are
 * the same document.
 */
function setDomainData(
  doc: ManufaktureDocument,
  command: SetDomainDataCommand,
): CoreResult<Applied> {
  const { namespace } = command;
  const inverse = domainDataCommand(doc, namespace);
  const domains: Record<string, DomainData> = { ...doc.domains };
  if (command.schemaVersion === undefined || !('data' in command)) {
    if (!Object.hasOwn(domains, namespace)) return ok({ document: doc, inverse });
    delete domains[namespace];
  } else {
    if (!Object.hasOwn(domains, namespace) && Object.keys(domains).length >= MAX_DOMAINS) {
      return fail(
        'schema',
        `The document already holds ${MAX_DOMAINS} domain entries, the most allowed`,
        ['namespace'],
      );
    }
    domains[namespace] = { schemaVersion: command.schemaVersion, data: command.data };
  }
  const { domains: _old, ...rest } = doc;
  void _old;
  return ok({
    document: Object.keys(domains).length === 0 ? rest : { ...rest, domains },
    inverse,
  });
}

/** Each counter at the higher of its values in `a` and `b`. */
function maxCounters(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, n] of Object.entries(b ?? {})) out[key] = Math.max(out[key] ?? 1, n);
  return out;
}

/**
 * The replacement a restore puts in place of `current`: `past` (an earlier version or revision of
 * it, or one from another branch) as it was, but with `current`'s id and with every id counter
 * (the document's, the print section's, and those of each part, assembly and drawing both have)
 * at the higher of the two values, so an id handed out after `past` is never handed out again.
 * The result is what `replaceDocument` takes.
 */
export function restoredDocument(
  current: ManufaktureDocument,
  past: ManufaktureDocument,
): ManufaktureDocument {
  const parts = new Map(current.parts.map((p) => [p.id, p]));
  const assemblies = new Map(current.assemblies.map((a) => [a.id, a]));
  const drawings = new Map((current.drawings ?? []).map((d) => [d.id, d]));
  return {
    ...past,
    ...(past.drawings && {
      drawings: past.drawings.map((d) => ({
        ...d,
        nextIds: maxCounters(d.nextIds, drawings.get(d.id)?.nextIds),
      })),
    }),
    id: current.id,
    parts: past.parts.map((p) => ({
      ...p,
      nextIds: maxCounters(p.nextIds, parts.get(p.id)?.nextIds),
    })),
    assemblies: past.assemblies.map((a) => ({
      ...a,
      nextIds: maxCounters(a.nextIds, assemblies.get(a.id)?.nextIds),
    })),
    print: { ...past.print, nextIds: maxCounters(past.print.nextIds, current.print.nextIds) },
    nextIds: maxCounters(past.nextIds, current.nextIds),
  };
}

/** Commands that add, remove, rename or move whole part studios. */
type PartsCommand = Extract<
  SimpleCommand,
  {
    type:
      'addPart' | 'renamePart' | 'deletePart' | 'restorePart' | 'reorderParts' | 'duplicatePart';
  }
>;

/** Commands that change what is inside one part. */
type PartCommand = Exclude<Extract<SimpleCommand, { partId: string }>, PartsCommand>;

function applyToPart(doc: ManufaktureDocument, command: PartCommand): CoreResult<Applied> {
  const pi = doc.parts.findIndex((p) => p.id === command.partId);
  const part = doc.parts[pi];
  if (!part) return fail('not-found', `No part "${command.partId}"`, ['partId']);
  if (command.type === 'deleteFeature') {
    // A suppression parameter names the feature: delete the parameter in the same batch.
    const params = (doc.configurations?.parameters ?? [])
      .filter(
        (p) =>
          p.kind === 'suppression' &&
          p.partId === command.partId &&
          p.featureId === command.featureId,
      )
      .map((p) => p.id);
    if (params.length > 0) {
      return fail(
        'dependency',
        `Cannot delete ${command.featureId}: configuration parameter ${params.join(', ')} suppresses it`,
        ['featureId'],
        { blockers: params },
      );
    }
  }
  const r = applyPartCommand(part, command);
  if (!r.ok) return r;
  const parts = doc.parts.slice();
  parts[pi] = r.value.part;
  return ok({ document: { ...doc, parts }, inverse: r.value.inverse });
}

interface PartApplied {
  part: Part;
  inverse: Command;
}

function featureIndex(part: Part, id: string): CoreResult<number> {
  const i = part.features.findIndex((f) => f.id === id);
  return i < 0 ? fail('not-found', `No feature "${id}" in part ${part.id}`, ['featureId']) : ok(i);
}

/** Ids a feature state carries: its own id and every id inside it. */
function allIds(feature: Feature): string[] {
  return [feature.id, ...featureSubIds(feature)];
}

/** The id a split piece was cut from: `e2#a` gives `e2`, `e2#a#b` gives `e2#a`. */
function splitParent(id: string): string {
  return id.slice(0, id.lastIndexOf('#'));
}

/**
 * Checks the ids a command introduces and returns the part's updated counters.
 * - `fresh` (add, edit): each id straight from a counter must not have been handed out before,
 *   and allocating it moves the counter past it. A split id (`e2#a`, or `e2#a#b` from `e2#a`)
 *   must split an id that the feature had before the command and no longer has after it. Split
 *   pieces have no counter, so this is what keeps them from being reused: once `e2` has been
 *   split and is gone, nothing can name `e2#a` again, and an entity of another feature cannot
 *   be split into this one. `addFeature` has no earlier state, so it takes no split ids.
 * - `restore` (undo and redo): each id must have been allocated before; counters do not move.
 *   This is weaker than `fresh` on purpose: undo and redo put back states that really existed.
 */
function allocate(
  nextIds: Readonly<Record<string, number>>,
  introduced: readonly string[],
  mode:
    { type: 'fresh'; before: readonly string[]; after: readonly string[] } | { type: 'restore' },
): CoreResult<Record<string, number>> {
  const out = { ...nextIds };
  const before = new Set(mode.type === 'fresh' ? mode.before : []);
  const after = new Set(mode.type === 'fresh' ? mode.after : []);
  for (const id of introduced) {
    const p = parseAnyId(id);
    if (!p) return fail('invalid-id', `"${id}" is not a valid id`, [], { blockers: [id] });
    const next = peekCounter(nextIds, p.counter);
    if (mode.type === 'restore') {
      if (p.n >= next) {
        return fail('invalid-id', `Id "${id}" was never allocated, so it cannot be restored`, [], {
          blockers: [id],
        });
      }
    } else if (p.split !== '') {
      const parent = splitParent(id);
      if (!before.has(parent) || after.has(parent)) {
        const why = !before.has(parent)
          ? `this feature did not have "${parent}" before the change`
          : `"${parent}" is still there`;
        return fail(
          'invalid-id',
          `Id "${id}" must come from splitting "${parent}" in this change, but ${why}; split ids are never reused`,
          [],
          { blockers: [id] },
        );
      }
    } else {
      if (p.n < next) {
        return fail(
          'id-reused',
          `Id "${id}" was already used; ids are never reused (next is ${next})`,
          [],
          {
            blockers: [id],
          },
        );
      }
      out[p.counter] = Math.max(peekCounter(out, p.counter), p.n + 1);
    }
  }
  return ok(out);
}

/** Ids in `next` that are not in `prev`, in order. */
function introducedIds(prev: readonly string[], next: readonly string[]): string[] {
  const have = new Set(prev);
  return next.filter((id) => !have.has(id));
}

function withFeatures(
  part: Part,
  features: Feature[],
  rollbackIndex: number | null,
  nextIds = part.nextIds,
): Part {
  return { ...part, features, rollbackIndex, nextIds };
}

function insertRollback(rb: number | null, at: number): number | null {
  return rb !== null && at <= rb ? rb + 1 : rb;
}

function removeRollback(rb: number | null, at: number): number | null {
  return rb !== null && at < rb ? rb - 1 : rb;
}

function dependentsOf(part: Part, id: string): string[] {
  return part.features.filter((f) => featureDependencies(f).includes(id)).map((f) => f.id);
}

/** Bodies with props that the feature `id` creates, by body id. */
function propsOf(part: Part, id: string): string[] {
  return part.bodies.filter((b) => bodyCreator(b.id) === id).map((b) => b.id);
}

/** The props fields of an entry, without its id. */
function propsFields(entry: BodyProps): BodyPropsFields {
  const { id: _id, ...fields } = entry;
  void _id;
  return fields;
}

function applyPartCommand(part: Part, command: PartCommand): CoreResult<PartApplied> {
  const { partId } = command;
  switch (command.type) {
    case 'addFeature': {
      const f = command.feature;
      if (part.features.some((x) => x.id === f.id)) {
        return fail('duplicate', `Feature "${f.id}" already exists`, ['feature', 'id']);
      }
      const at = command.index ?? part.rollbackIndex ?? part.features.length;
      if (at > part.features.length) {
        return fail(
          'invalid-index',
          `Index ${at} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      const ids = allocate(part.nextIds, allIds(f), { type: 'fresh', before: [], after: [] });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features.splice(at, 0, f);
      return ok({
        part: withFeatures(part, features, insertRollback(part.rollbackIndex, at), ids.value),
        inverse: { type: 'deleteFeature', partId, featureId: f.id },
      });
    }

    case 'editFeature': {
      const f = command.feature;
      const i = featureIndex(part, f.id);
      if (!i.ok) return i;
      const old = part.features[i.value]!;
      if (old.kind !== f.kind) {
        return fail(
          'kind-mismatch',
          `${f.id} is a ${old.kind}; an edit cannot make it a ${f.kind}`,
          ['feature', 'kind'],
        );
      }
      const before = allIds(old);
      const after = allIds(f);
      const ids = allocate(part.nextIds, introducedIds(before, after), {
        type: 'fresh',
        before,
        after,
      });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features[i.value] = f;
      return ok({
        part: withFeatures(part, features, part.rollbackIndex, ids.value),
        inverse: {
          type: 'restoreFeature',
          partId,
          feature: old,
          index: i.value,
          rollbackIndex: part.rollbackIndex,
        },
      });
    }

    case 'deleteFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const dependents = dependentsOf(part, command.featureId);
      if (dependents.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.featureId}: ${dependents.join(', ')} ${dependents.length === 1 ? 'depends' : 'depend'} on it`,
          ['featureId'],
          { blockers: dependents },
        );
      }
      // Props of a body the feature makes: clear them in the same batch (`setBodyProps` with
      // empty props), so undo brings both back.
      const props = propsOf(part, command.featureId);
      if (props.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.featureId}: body ${props.join(', ')} ${props.length === 1 ? 'has' : 'have'} a name, colour or material`,
          ['featureId'],
          { blockers: props },
        );
      }
      const old = part.features[i.value]!;
      const features = part.features.slice();
      features.splice(i.value, 1);
      return ok({
        part: withFeatures(part, features, removeRollback(part.rollbackIndex, i.value)),
        inverse: {
          type: 'restoreFeature',
          partId,
          feature: old,
          index: i.value,
          rollbackIndex: part.rollbackIndex,
        },
      });
    }

    case 'restoreFeature': {
      const f = command.feature;
      const existing = part.features.findIndex((x) => x.id === f.id);
      if (
        command.rollbackIndex !== null &&
        command.rollbackIndex > part.features.length + (existing < 0 ? 1 : 0)
      ) {
        return fail('invalid-index', `Rollback index ${command.rollbackIndex} is out of range`, [
          'rollbackIndex',
        ]);
      }
      if (existing >= 0) {
        if (existing !== command.index) {
          return fail('invalid-index', `${f.id} is at ${existing}, not ${command.index}`, [
            'index',
          ]);
        }
        const old = part.features[existing]!;
        if (old.kind !== f.kind) {
          return fail('kind-mismatch', `${f.id} is a ${old.kind}, not a ${f.kind}`, [
            'feature',
            'kind',
          ]);
        }
        const ids = allocate(part.nextIds, introducedIds(allIds(old), allIds(f)), {
          type: 'restore',
        });
        if (!ids.ok) return ids;
        const features = part.features.slice();
        features[existing] = f;
        return ok({
          part: withFeatures(part, features, command.rollbackIndex),
          inverse: {
            type: 'restoreFeature',
            partId,
            feature: old,
            index: existing,
            rollbackIndex: part.rollbackIndex,
          },
        });
      }
      if (command.index > part.features.length) {
        return fail(
          'invalid-index',
          `Index ${command.index} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      const ids = allocate(part.nextIds, allIds(f), { type: 'restore' });
      if (!ids.ok) return ids;
      const features = part.features.slice();
      features.splice(command.index, 0, f);
      const del: Command = { type: 'deleteFeature', partId, featureId: f.id };
      const inverse: Command =
        removeRollback(command.rollbackIndex, command.index) === part.rollbackIndex
          ? del
          : {
              type: 'batch',
              commands: [del, { type: 'setRollback', partId, index: part.rollbackIndex }],
            };
      return ok({ part: withFeatures(part, features, command.rollbackIndex), inverse });
    }

    case 'reorderFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const to = command.index;
      if (to >= part.features.length) {
        return fail(
          'invalid-index',
          `Index ${to} is past the last of ${part.features.length} features`,
          ['index'],
        );
      }
      const moved = part.features[i.value]!;
      const features = part.features.slice();
      features.splice(i.value, 1);
      features.splice(to, 0, moved);
      const pos = new Map(features.map((f, k) => [f.id, k]));
      const passedDeps = featureDependencies(moved).filter((d) => (pos.get(d) ?? -1) > to);
      if (passedDeps.length > 0) {
        return fail(
          'dependency',
          `${moved.id} cannot move before ${passedDeps.join(', ')}, which it references`,
          ['index'],
          { blockers: passedDeps },
        );
      }
      const passedUsers = dependentsOf(part, moved.id).filter((d) => (pos.get(d) ?? Infinity) < to);
      if (passedUsers.length > 0) {
        return fail(
          'dependency',
          `${moved.id} cannot move after ${passedUsers.join(', ')}, which ${passedUsers.length === 1 ? 'references' : 'reference'} it`,
          ['index'],
          { blockers: passedUsers },
        );
      }
      return ok({
        part: withFeatures(part, features, part.rollbackIndex),
        inverse: { type: 'reorderFeature', partId, featureId: moved.id, index: i.value },
      });
    }

    case 'suppressFeature':
    case 'renameFeature': {
      const i = featureIndex(part, command.featureId);
      if (!i.ok) return i;
      const old = part.features[i.value]!;
      const features = part.features.slice();
      if (command.type === 'suppressFeature') {
        features[i.value] = { ...old, suppressed: command.suppressed };
        return ok({
          part: withFeatures(part, features, part.rollbackIndex),
          inverse: {
            type: 'suppressFeature',
            partId,
            featureId: old.id,
            suppressed: old.suppressed,
          },
        });
      }
      const name = command.name.trim();
      if (name.length === 0 || name.length > 200) {
        return fail('invalid-name', 'A feature name must be 1 to 200 characters', ['name']);
      }
      features[i.value] = { ...old, name };
      return ok({
        part: withFeatures(part, features, part.rollbackIndex),
        inverse: { type: 'renameFeature', partId, featureId: old.id, name: old.name },
      });
    }

    case 'setMaterial': {
      const { material: _old, ...rest } = part;
      void _old;
      return ok({
        part: command.material === null ? rest : { ...rest, material: command.material },
        inverse: { type: 'setMaterial', partId, material: part.material ?? null },
      });
    }

    case 'setBodyProps': {
      const i = part.bodies.findIndex((b) => b.id === command.bodyId);
      const old = part.bodies[i];
      const entry: BodyProps = { id: command.bodyId, ...command.props };
      const empty = Object.keys(command.props).length === 0;
      const bodies = part.bodies.slice();
      if (old) {
        if (empty) bodies.splice(i, 1);
        else bodies[i] = entry;
      } else if (!empty) {
        const at = command.index ?? bodies.length;
        if (at > bodies.length) {
          return fail(
            'invalid-index',
            `Index ${at} is past the end of ${bodies.length} body entries`,
            ['index'],
          );
        }
        bodies.splice(at, 0, entry);
      }
      const inverse: Command = old
        ? { type: 'setBodyProps', partId, bodyId: old.id, props: propsFields(old), index: i }
        : { type: 'setBodyProps', partId, bodyId: command.bodyId, props: {} };
      return ok({ part: old || !empty ? { ...part, bodies } : part, inverse });
    }

    case 'setRollback': {
      if (command.index !== null && command.index > part.features.length) {
        return fail(
          'invalid-index',
          `Rollback index ${command.index} is past the end of ${part.features.length} features`,
          ['index'],
        );
      }
      return ok({
        part: withFeatures(part, part.features, command.index),
        inverse: { type: 'setRollback', partId, index: part.rollbackIndex },
      });
    }
  }
}

function setVariable(
  doc: ManufaktureDocument,
  command: Extract<SimpleCommand, { type: 'setVariable' }>,
): CoreResult<Applied> {
  if (!isValidVariableName(command.name)) {
    return fail('invalid-name', `"${command.name}" is not a valid variable name`, ['name']);
  }
  const i = doc.variables.findIndex((v) => v.name === command.name);
  const variables = doc.variables.slice();
  if (i >= 0) {
    const old = variables[i]!;
    variables[i] = { name: command.name, expression: command.expression };
    return ok({
      document: { ...doc, variables },
      inverse: { type: 'setVariable', name: command.name, expression: old.expression },
    });
  }
  const at = command.index ?? variables.length;
  if (at > variables.length) {
    return fail('invalid-index', `Index ${at} is past the end of ${variables.length} variables`, [
      'index',
    ]);
  }
  variables.splice(at, 0, { name: command.name, expression: command.expression });
  return ok({
    document: { ...doc, variables },
    inverse: { type: 'deleteVariable', name: command.name },
  });
}

type ConfigCommand = Extract<
  SimpleCommand,
  {
    type:
      | 'setConfigParameter'
      | 'deleteConfigParameter'
      | 'restoreConfigParameter'
      | 'setConfigRow'
      | 'deleteConfigRow'
      | 'restoreConfigRow'
      | 'setActiveConfiguration';
  }
>;

/**
 * `doc` with the configuration table `table`. A table with nothing in it is dropped, so undoing
 * the first parameter or row gives back a document with no `configurations` at all.
 */
function withConfigurations(doc: ManufaktureDocument, table: Configurations): ManufaktureDocument {
  const { configurations: _old, ...rest } = doc;
  void _old;
  if (table.parameters.length === 0 && table.rows.length === 0 && table.active === null) {
    return rest;
  }
  return { ...rest, configurations: table };
}

/**
 * Allocates a document-level id `<counter>#n` for a new item: `fresh` refuses an id handed out
 * before and moves the counter past it; `restore` requires it to have been handed out.
 */
function allocateDocumentId(
  doc: ManufaktureDocument,
  counter: string,
  id: string,
  mode: 'fresh' | 'restore',
): CoreResult<Record<string, number>> {
  const n = Number(id.slice(counter.length + 1));
  const next = peekCounter(doc.nextIds, counter);
  if (mode === 'restore') {
    return n < next
      ? ok(doc.nextIds)
      : fail('invalid-id', `Id "${id}" was never allocated, so it cannot be restored`, [], {
          blockers: [id],
        });
  }
  if (n < next) {
    return fail(
      'id-reused',
      `Id "${id}" was already used; ids are never reused (next is ${counter}#${next})`,
      [],
      { blockers: [id] },
    );
  }
  return ok({ ...doc.nextIds, [counter]: n + 1 });
}

function insertAt<T>(list: readonly T[], item: T, at: number, what: string): CoreResult<T[]> {
  if (at > list.length) {
    return fail('invalid-index', `Index ${at} is past the end of ${list.length} ${what}`, [
      'index',
    ]);
  }
  const out = list.slice();
  out.splice(at, 0, item);
  return ok(out);
}

function applyToConfigurations(
  doc: ManufaktureDocument,
  command: ConfigCommand,
): CoreResult<Applied> {
  const table: Configurations = doc.configurations ?? { parameters: [], rows: [], active: null };
  const done = (next: Configurations, inverse: Command, nextIds = doc.nextIds) =>
    ok<Applied>({ document: { ...withConfigurations(doc, next), nextIds }, inverse });

  switch (command.type) {
    case 'setConfigParameter':
    case 'restoreConfigParameter': {
      const p = command.parameter;
      const i = table.parameters.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        if (command.type === 'restoreConfigParameter') {
          return fail('duplicate', `Configuration parameter "${p.id}" already exists`, [
            'parameter',
            'id',
          ]);
        }
        const parameters = table.parameters.slice();
        const old = parameters[i]!;
        parameters[i] = p;
        return done({ ...table, parameters }, { type: 'setConfigParameter', parameter: old });
      }
      const ids = allocateDocumentId(
        doc,
        CONFIG_PARAMETER_COUNTER,
        p.id,
        command.type === 'restoreConfigParameter' ? 'restore' : 'fresh',
      );
      if (!ids.ok) return ids;
      const parameters = insertAt(
        table.parameters,
        p,
        command.index ?? table.parameters.length,
        'configuration parameters',
      );
      if (!parameters.ok) return parameters;
      return done(
        { ...table, parameters: parameters.value },
        { type: 'deleteConfigParameter', parameterId: p.id },
        ids.value,
      );
    }

    case 'deleteConfigParameter': {
      const i = table.parameters.findIndex((x) => x.id === command.parameterId);
      const old = table.parameters[i];
      if (!old) {
        return fail('not-found', `No configuration parameter "${command.parameterId}"`, [
          'parameterId',
        ]);
      }
      const parameters = table.parameters.slice();
      parameters.splice(i, 1);
      const restoreRows: Command[] = [];
      const rows = table.rows.map((row): ConfigRow => {
        if (!(old.id in row.values)) return row;
        restoreRows.push({ type: 'setConfigRow', row });
        const values = { ...row.values };
        delete values[old.id];
        return { ...row, values };
      });
      const restore: Command = { type: 'restoreConfigParameter', parameter: old, index: i };
      return done(
        { ...table, parameters, rows },
        restoreRows.length === 0 ? restore : { type: 'batch', commands: [restore, ...restoreRows] },
      );
    }

    case 'setConfigRow':
    case 'restoreConfigRow': {
      const r = command.row;
      const i = table.rows.findIndex((x) => x.id === r.id);
      if (i >= 0) {
        if (command.type === 'restoreConfigRow') {
          return fail('duplicate', `Configuration row "${r.id}" already exists`, ['row', 'id']);
        }
        const rows = table.rows.slice();
        const old = rows[i]!;
        rows[i] = r;
        return done({ ...table, rows }, { type: 'setConfigRow', row: old });
      }
      const ids = allocateDocumentId(
        doc,
        CONFIG_ROW_COUNTER,
        r.id,
        command.type === 'restoreConfigRow' ? 'restore' : 'fresh',
      );
      if (!ids.ok) return ids;
      const rows = insertAt(
        table.rows,
        r,
        command.index ?? table.rows.length,
        'configuration rows',
      );
      if (!rows.ok) return rows;
      return done(
        { ...table, rows: rows.value },
        { type: 'deleteConfigRow', rowId: r.id },
        ids.value,
      );
    }

    case 'deleteConfigRow': {
      const i = table.rows.findIndex((x) => x.id === command.rowId);
      const old = table.rows[i];
      if (!old) return fail('not-found', `No configuration row "${command.rowId}"`, ['rowId']);
      const users = rowInstances(doc, old.id);
      if (users.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${old.id}: ${users.length === 1 ? 'instance' : 'instances'} ${users.join(', ')} ${users.length === 1 ? 'is' : 'are'} built in it`,
          ['rowId'],
          { blockers: users },
        );
      }
      const rows = table.rows.slice();
      rows.splice(i, 1);
      const wasActive = table.active === old.id;
      const restore: Command = { type: 'restoreConfigRow', row: old, index: i };
      return done(
        { ...table, rows, active: wasActive ? null : table.active },
        wasActive
          ? {
              type: 'batch',
              commands: [restore, { type: 'setActiveConfiguration', rowId: old.id }],
            }
          : restore,
      );
    }

    case 'setActiveConfiguration': {
      if (command.rowId !== null && !table.rows.some((r) => r.id === command.rowId)) {
        return fail('not-found', `No configuration row "${command.rowId}"`, ['rowId']);
      }
      return done(
        { ...table, active: command.rowId },
        { type: 'setActiveConfiguration', rowId: table.active },
      );
    }
  }
}

function partName(raw: string): CoreResult<string> {
  const name = raw.trim();
  return name.length === 0 || name.length > MAX_PART_NAME
    ? fail('invalid-name', `A part studio name must be 1 to ${MAX_PART_NAME} characters`, ['name'])
    : ok(name);
}

/** Allocates a fresh `part#n` for a new part studio. */
function allocatePartId(doc: ManufaktureDocument, id: string): CoreResult<Record<string, number>> {
  if (!PART_ID_PATTERN.test(id)) {
    return fail('invalid-id', `"${id}" is not a part id (part#n)`, ['partId'], { blockers: [id] });
  }
  if (doc.parts.some((p) => p.id === id)) {
    return fail('duplicate', `Part "${id}" already exists`, ['partId']);
  }
  return allocateDocumentId(doc, PART_COUNTER, id, 'fresh');
}

/** Configuration parameters that suppress a feature of part `partId`. */
export function partParameters(doc: ManufaktureDocument, partId: string): string[] {
  return (doc.configurations?.parameters ?? [])
    .filter((p) => p.kind === 'suppression' && p.partId === partId)
    .map((p) => p.id);
}

function applyToParts(doc: ManufaktureDocument, command: PartsCommand): CoreResult<Applied> {
  const done = (parts: Part[], inverse: Command, nextIds = doc.nextIds) =>
    ok<Applied>({ document: { ...doc, parts, nextIds }, inverse });
  const find = (id: string, field = 'partId'): CoreResult<number> => {
    const i = doc.parts.findIndex((p) => p.id === id);
    return i < 0 ? fail('not-found', `No part "${id}"`, [field]) : ok(i);
  };

  switch (command.type) {
    case 'addPart':
    case 'duplicatePart': {
      const name = partName(command.name);
      if (!name.ok) return name;
      let part: Part = createPart(command.partId, name.value);
      let at = doc.parts.length;
      if (command.type === 'duplicatePart') {
        const si = find(command.sourcePartId, 'sourcePartId');
        if (!si.ok) return si;
        part = { ...doc.parts[si.value]!, id: command.partId, name: name.value };
        at = si.value + 1;
      }
      const ids = allocatePartId(doc, command.partId);
      if (!ids.ok) return ids;
      const parts = insertAt(doc.parts, part, command.index ?? at, 'parts');
      if (!parts.ok) return parts;
      return done(parts.value, { type: 'deletePart', partId: command.partId }, ids.value);
    }

    case 'renamePart': {
      const i = find(command.partId);
      if (!i.ok) return i;
      const name = partName(command.name);
      if (!name.ok) return name;
      const old = doc.parts[i.value]!;
      const parts = doc.parts.slice();
      parts[i.value] = { ...old, name: name.value };
      return done(parts, { type: 'renamePart', partId: old.id, name: old.name });
    }

    case 'deletePart': {
      const i = find(command.partId);
      if (!i.ok) return i;
      if (doc.parts.length === 1) {
        return fail('last-part', 'A document keeps at least one part studio', ['partId']);
      }
      const params = partParameters(doc, command.partId);
      if (params.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.partId}: configuration parameter ${params.join(', ')} suppresses a feature in it`,
          ['partId'],
          { blockers: params },
        );
      }
      const instances = partInstances(doc, command.partId);
      if (instances.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.partId}: ${instances.length === 1 ? 'instance' : 'instances'} ${instances.join(', ')} ${instances.length === 1 ? 'shows' : 'show'} it`,
          ['partId'],
          { blockers: instances },
        );
      }
      const items = partPrintItems(doc, command.partId);
      if (items.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.partId}: print ${items.length === 1 ? 'item' : 'items'} ${items.join(', ')} ${items.length === 1 ? 'prints' : 'print'} it`,
          ['partId'],
          { blockers: items },
        );
      }
      const views = partViews(doc, command.partId);
      if (views.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.partId}: drawing ${views.length === 1 ? 'view' : 'views'} ${views.join(', ')} ${views.length === 1 ? 'shows' : 'show'} it`,
          ['partId'],
          { blockers: views },
        );
      }
      const parts = doc.parts.slice();
      const [old] = parts.splice(i.value, 1);
      return done(parts, { type: 'restorePart', part: old!, index: i.value });
    }

    case 'restorePart': {
      const p = command.part;
      if (doc.parts.some((x) => x.id === p.id)) {
        return fail('duplicate', `Part "${p.id}" already exists`, ['part', 'id']);
      }
      if (PART_ID_PATTERN.test(p.id)) {
        const ids = allocateDocumentId(doc, PART_COUNTER, p.id, 'restore');
        if (!ids.ok) return ids;
      }
      const parts = insertAt(doc.parts, p, command.index, 'parts');
      if (!parts.ok) return parts;
      return done(parts.value, { type: 'deletePart', partId: p.id });
    }

    case 'reorderParts': {
      const i = find(command.partId);
      if (!i.ok) return i;
      if (command.index >= doc.parts.length) {
        return fail(
          'invalid-index',
          `Index ${command.index} is past the last of ${doc.parts.length} parts`,
          ['index'],
        );
      }
      const parts = doc.parts.slice();
      const [moved] = parts.splice(i.value, 1);
      parts.splice(command.index, 0, moved!);
      return done(parts, { type: 'reorderParts', partId: command.partId, index: i.value });
    }
  }
}

/**
 * Instances, in any assembly, that show part `partId` of this document, as
 * `<assembly id>/<instance id>` (instance ids are per assembly).
 */
export function partInstances(doc: ManufaktureDocument, partId: string): string[] {
  const out: string[] = [];
  for (const assembly of doc.assemblies) {
    for (const instance of assembly.instances) {
      if (instancePart(instance.source) === partId) out.push(`${assembly.id}/${instance.id}`);
    }
  }
  return out;
}

/**
 * Instances of parts of this document, in any assembly, built in configuration row `rowId`, as
 * `<assembly id>/<instance id>`. Pinned sources name rows of their own document, so none count.
 */
export function rowInstances(doc: ManufaktureDocument, rowId: string): string[] {
  const out: string[] = [];
  for (const assembly of doc.assemblies) {
    for (const instance of assembly.instances) {
      const s = instance.source;
      if (!isPinnedSource(s) && s.configuration === rowId)
        out.push(`${assembly.id}/${instance.id}`);
    }
  }
  return out;
}

type AssembliesCommand = Extract<
  SimpleCommand,
  { type: 'addAssembly' | 'renameAssembly' | 'deleteAssembly' | 'restoreAssembly' }
>;

function assemblyName(raw: string): CoreResult<string> {
  const name = raw.trim();
  return name.length === 0 || name.length > MAX_ASSEMBLY_NAME
    ? fail('invalid-name', `An assembly name must be 1 to ${MAX_ASSEMBLY_NAME} characters`, [
        'name',
      ])
    : ok(name);
}

function applyToAssemblies(
  doc: ManufaktureDocument,
  command: AssembliesCommand,
): CoreResult<Applied> {
  const done = (assemblies: Assembly[], inverse: Command, nextIds = doc.nextIds) =>
    ok<Applied>({ document: { ...doc, assemblies, nextIds }, inverse });
  const find = (id: string): CoreResult<number> => {
    const i = doc.assemblies.findIndex((a) => a.id === id);
    return i < 0 ? fail('not-found', `No assembly "${id}"`, ['assemblyId']) : ok(i);
  };

  switch (command.type) {
    case 'addAssembly': {
      const name = assemblyName(command.name);
      if (!name.ok) return name;
      const id = command.assemblyId;
      if (!ASSEMBLY_ID_PATTERN.test(id)) {
        return fail('invalid-id', `"${id}" is not an assembly id (assembly#n)`, ['assemblyId'], {
          blockers: [id],
        });
      }
      if (doc.assemblies.some((a) => a.id === id)) {
        return fail('duplicate', `Assembly "${id}" already exists`, ['assemblyId']);
      }
      const ids = allocateDocumentId(doc, ASSEMBLY_COUNTER, id, 'fresh');
      if (!ids.ok) return ids;
      const assemblies = insertAt(
        doc.assemblies,
        createAssembly(id, name.value),
        command.index ?? doc.assemblies.length,
        'assemblies',
      );
      if (!assemblies.ok) return assemblies;
      return done(assemblies.value, { type: 'deleteAssembly', assemblyId: id }, ids.value);
    }

    case 'renameAssembly': {
      const i = find(command.assemblyId);
      if (!i.ok) return i;
      const name = assemblyName(command.name);
      if (!name.ok) return name;
      const old = doc.assemblies[i.value]!;
      const assemblies = doc.assemblies.slice();
      assemblies[i.value] = { ...old, name: name.value };
      return done(assemblies, { type: 'renameAssembly', assemblyId: old.id, name: old.name });
    }

    case 'deleteAssembly': {
      const i = find(command.assemblyId);
      if (!i.ok) return i;
      const views = assemblyViews(doc, command.assemblyId);
      if (views.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.assemblyId}: drawing ${views.length === 1 ? 'view' : 'views'} ${views.join(', ')} ${views.length === 1 ? 'shows' : 'show'} it`,
          ['assemblyId'],
          { blockers: views },
        );
      }
      const assemblies = doc.assemblies.slice();
      const [old] = assemblies.splice(i.value, 1);
      return done(assemblies, { type: 'restoreAssembly', assembly: old!, index: i.value });
    }

    case 'restoreAssembly': {
      const a = command.assembly;
      if (doc.assemblies.some((x) => x.id === a.id)) {
        return fail('duplicate', `Assembly "${a.id}" already exists`, ['assembly', 'id']);
      }
      const ids = allocateDocumentId(doc, ASSEMBLY_COUNTER, a.id, 'restore');
      if (!ids.ok) return ids;
      const assemblies = insertAt(doc.assemblies, a, command.index, 'assemblies');
      if (!assemblies.ok) return assemblies;
      return done(assemblies.value, { type: 'deleteAssembly', assemblyId: a.id });
    }
  }
}

/**
 * The outlines that use font `fontId`, as `<part id>/<sketch id>/<entity id>`, in document
 * order: what blocks deleting the font.
 */
export function fontUsers(doc: ManufaktureDocument, fontId: string): string[] {
  const out: string[] = [];
  for (const part of doc.parts) {
    for (const f of part.features) {
      if (f.kind !== 'sketch') continue;
      for (const e of f.entities) {
        if (e.kind === 'outline' && e.source.kind === 'text' && e.source.font === fontId)
          out.push(`${part.id}/${f.id}/${e.id}`);
      }
    }
  }
  return out;
}

type FontsCommand = Extract<SimpleCommand, { type: 'addFont' | 'deleteFont' | 'restoreFont' }>;

/** A failure when adding `font` would take the document's fonts past `MAX_FONT_TOTAL_BYTES`. */
function fontsTooBig(doc: ManufaktureDocument, font: DocumentFont): CoreResult<never> | null {
  const total = fontBytes([...doc.fonts, font]);
  if (total <= MAX_FONT_TOTAL_BYTES) return null;
  const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return fail(
    'schema',
    `The document's fonts would hold ${mib(total)}; at most ${mib(MAX_FONT_TOTAL_BYTES)} of fonts are allowed: delete a font first`,
    ['font', 'source', 'size'],
  );
}

function applyToFonts(doc: ManufaktureDocument, command: FontsCommand): CoreResult<Applied> {
  const done = (fonts: DocumentFont[], inverse: Command, nextIds = doc.nextIds) =>
    ok<Applied>({ document: { ...doc, fonts, nextIds }, inverse });
  const sameBytes = (font: DocumentFont) =>
    doc.fonts.find((f) => f.id !== font.id && f.source.sha256 === font.source.sha256);

  switch (command.type) {
    case 'addFont': {
      const { font } = command;
      if (!FONT_ID_PATTERN.test(font.id)) {
        return fail('invalid-id', `"${font.id}" is not a font id (font#n)`, ['font', 'id'], {
          blockers: [font.id],
        });
      }
      if (doc.fonts.some((f) => f.id === font.id)) {
        return fail('duplicate', `Font "${font.id}" already exists`, ['font', 'id']);
      }
      const twin = sameBytes(font);
      if (twin) {
        return fail('duplicate', `The document already has this font, as ${twin.id}`, ['font'], {
          blockers: [twin.id],
        });
      }
      const tooBig = fontsTooBig(doc, font);
      if (tooBig) return tooBig;
      const ids = allocateDocumentId(doc, FONT_COUNTER, font.id, 'fresh');
      if (!ids.ok) return ids;
      const fonts = insertAt(doc.fonts, font, command.index ?? doc.fonts.length, 'fonts');
      if (!fonts.ok) return fonts;
      return done(fonts.value, { type: 'deleteFont', fontId: font.id }, ids.value);
    }

    case 'deleteFont': {
      const i = doc.fonts.findIndex((f) => f.id === command.fontId);
      if (i < 0) return fail('not-found', `No font "${command.fontId}"`, ['fontId']);
      const users = fontUsers(doc, command.fontId);
      if (users.length > 0) {
        return fail(
          'dependency',
          `Font ${command.fontId} is used by ${users.join(', ')}: change or delete those texts first`,
          ['fontId'],
          { blockers: users },
        );
      }
      const fonts = doc.fonts.slice();
      const [old] = fonts.splice(i, 1);
      return done(fonts, { type: 'restoreFont', font: old!, index: i });
    }

    case 'restoreFont': {
      const { font } = command;
      if (doc.fonts.some((f) => f.id === font.id)) {
        return fail('duplicate', `Font "${font.id}" already exists`, ['font', 'id']);
      }
      const ids = allocateDocumentId(doc, FONT_COUNTER, font.id, 'restore');
      if (!ids.ok) return ids;
      const fonts = insertAt(doc.fonts, font, command.index, 'fonts');
      if (!fonts.ok) return fonts;
      return done(fonts.value, { type: 'deleteFont', fontId: font.id });
    }
  }
}

type AssemblyCommand = Exclude<Extract<SimpleCommand, { assemblyId: string }>, AssembliesCommand>;

/** Commands that change what is inside one assembly. */
function applyToAssembly(doc: ManufaktureDocument, command: AssemblyCommand): CoreResult<Applied> {
  const ai = doc.assemblies.findIndex((a) => a.id === command.assemblyId);
  const assembly = doc.assemblies[ai];
  if (!assembly) return fail('not-found', `No assembly "${command.assemblyId}"`, ['assemblyId']);
  if (
    command.type === 'deleteInstance' &&
    assembly.instances.some((x) => x.id === command.instanceId)
  ) {
    // Exploded steps name the instance: edit or delete them in the same batch. (Mates are
    // checked with the assembly.) Drawing dimensions do not block: they report reference-lost.
    const blockers = instanceExplodedViews(assembly, command.instanceId).map(
      (id) => `${assembly.id}/${id}`,
    );
    if (blockers.length > 0) {
      return fail(
        'dependency',
        `Cannot delete ${command.instanceId}: ${blockers.join(', ')} ${blockers.length === 1 ? 'uses' : 'use'} it`,
        ['instanceId'],
        { blockers },
      );
    }
  }
  if (command.type === 'deleteExplodedView') {
    const views = explodedViewViews(doc, assembly.id, command.explodedViewId);
    if (views.length > 0) {
      return fail(
        'dependency',
        `Cannot delete ${command.explodedViewId}: drawing ${views.length === 1 ? 'view' : 'views'} ${views.join(', ')} ${views.length === 1 ? 'shows' : 'show'} it`,
        ['explodedViewId'],
        { blockers: views },
      );
    }
  }
  const r = applyAssemblyCommand(assembly, command);
  if (!r.ok) return r;
  const assemblies = doc.assemblies.slice();
  assemblies[ai] = r.value.assembly;
  return ok({ document: { ...doc, assemblies }, inverse: r.value.inverse });
}

interface AssemblyApplied {
  assembly: Assembly;
  inverse: Command;
}

function applyAssemblyCommand(
  assembly: Assembly,
  command: AssemblyCommand,
): CoreResult<AssemblyApplied> {
  const { assemblyId } = command;
  const done = (changes: Partial<Assembly>, inverse: Command) =>
    ok<AssemblyApplied>({ assembly: { ...assembly, ...changes }, inverse });
  const findInstance = (id: string): CoreResult<number> => {
    const i = assembly.instances.findIndex((x) => x.id === id);
    return i < 0
      ? fail('not-found', `No instance "${id}" in assembly ${assembly.id}`, ['instanceId'])
      : ok(i);
  };
  const findMate = (id: string): CoreResult<number> => {
    const i = assembly.mates.findIndex((x) => x.id === id);
    return i < 0
      ? fail('not-found', `No mate "${id}" in assembly ${assembly.id}`, ['mateId'])
      : ok(i);
  };

  switch (command.type) {
    case 'addInstance':
    case 'restoreInstance': {
      const inst = command.instance;
      if (assembly.instances.some((x) => x.id === inst.id)) {
        return fail('duplicate', `Instance "${inst.id}" already exists`, ['instance', 'id']);
      }
      const restore = command.type === 'restoreInstance';
      const ids = allocate(
        assembly.nextIds,
        [inst.id],
        restore ? { type: 'restore' } : { type: 'fresh', before: [], after: [] },
      );
      if (!ids.ok) return ids;
      const instances = insertAt(
        assembly.instances,
        inst,
        restore ? command.index : assembly.instances.length,
        'instances',
      );
      if (!instances.ok) return instances;
      return done(
        { instances: instances.value, nextIds: ids.value },
        { type: 'deleteInstance', assemblyId, instanceId: inst.id },
      );
    }

    case 'editInstance': {
      const i = findInstance(command.instanceId);
      if (!i.ok) return i;
      const old = assembly.instances[i.value]!;
      let next: Instance = old;
      const inverse: Extract<SimpleCommand, { type: 'editInstance' }> = {
        type: 'editInstance',
        assemblyId,
        instanceId: old.id,
      };
      if (command.name !== undefined) {
        const name = command.name.trim();
        if (name.length === 0 || name.length > MAX_INSTANCE_NAME) {
          return fail(
            'invalid-name',
            `An instance name must be 1 to ${MAX_INSTANCE_NAME} characters`,
            ['name'],
          );
        }
        next = { ...next, name };
        inverse.name = old.name;
      }
      if (command.fixed !== undefined) {
        next = { ...next, fixed: command.fixed };
        inverse.fixed = old.fixed;
      }
      if (command.suppressed !== undefined) {
        next = { ...next, suppressed: command.suppressed };
        inverse.suppressed = old.suppressed;
      }
      if (command.source !== undefined) {
        next = { ...next, source: command.source };
        inverse.source = old.source;
      }
      if (command.bodies !== undefined) {
        const { bodies: _bodies, ...rest } = next;
        void _bodies;
        next = command.bodies === null ? rest : { ...rest, bodies: command.bodies };
        inverse.bodies = old.bodies ?? null;
      }
      const instances = assembly.instances.slice();
      instances[i.value] = next;
      return done({ instances }, inverse);
    }

    case 'setPoses': {
      const instances = assembly.instances.slice();
      const at = new Map(instances.map((x, i) => [x.id, i]));
      const old: Record<string, Pose> = {};
      for (const [id, pose] of Object.entries(command.poses)) {
        const i = at.get(id);
        if (i === undefined) {
          return fail('not-found', `No instance "${id}" in assembly ${assembly.id}`, ['poses', id]);
        }
        old[id] = instances[i]!.pose;
        instances[i] = { ...instances[i]!, pose };
      }
      return done({ instances }, { type: 'setPoses', assemblyId, poses: old });
    }

    case 'deleteInstance': {
      const i = findInstance(command.instanceId);
      if (!i.ok) return i;
      const mates = instanceMates(assembly, command.instanceId);
      if (mates.length > 0) {
        return fail(
          'dependency',
          `Cannot delete ${command.instanceId}: ${mates.length === 1 ? 'mate' : 'mates'} ${mates.join(', ')} ${mates.length === 1 ? 'connects' : 'connect'} it`,
          ['instanceId'],
          { blockers: mates },
        );
      }
      const instances = assembly.instances.slice();
      const [old] = instances.splice(i.value, 1);
      return done(
        { instances },
        { type: 'restoreInstance', assemblyId, instance: old!, index: i.value },
      );
    }

    case 'addMate': {
      const m = command.mate;
      if (assembly.mates.some((x) => x.id === m.id)) {
        return fail('duplicate', `Mate "${m.id}" already exists`, ['mate', 'id']);
      }
      const ids = allocate(assembly.nextIds, mateIds(m), { type: 'fresh', before: [], after: [] });
      if (!ids.ok) return ids;
      return done(
        { mates: [...assembly.mates, m], nextIds: ids.value },
        { type: 'deleteMate', assemblyId, mateId: m.id },
      );
    }

    case 'editMate': {
      const m = command.mate;
      const i = findMate(m.id);
      if (!i.ok) return i;
      const old = assembly.mates[i.value]!;
      const before = mateIds(old);
      const after = mateIds(m);
      const ids = allocate(assembly.nextIds, introducedIds(before, after), {
        type: 'fresh',
        before,
        after,
      });
      if (!ids.ok) return ids;
      const mates = assembly.mates.slice();
      mates[i.value] = m;
      return done(
        { mates, nextIds: ids.value },
        { type: 'restoreMate', assemblyId, mate: old, index: i.value },
      );
    }

    case 'restoreMate': {
      const m = command.mate;
      const existing = assembly.mates.findIndex((x) => x.id === m.id);
      if (existing >= 0) {
        if (existing !== command.index) {
          return fail('invalid-index', `${m.id} is at ${existing}, not ${command.index}`, [
            'index',
          ]);
        }
        const old = assembly.mates[existing]!;
        const ids = allocate(assembly.nextIds, introducedIds(mateIds(old), mateIds(m)), {
          type: 'restore',
        });
        if (!ids.ok) return ids;
        const mates = assembly.mates.slice();
        mates[existing] = m;
        return done({ mates }, { type: 'restoreMate', assemblyId, mate: old, index: existing });
      }
      const ids = allocate(assembly.nextIds, mateIds(m), { type: 'restore' });
      if (!ids.ok) return ids;
      const mates = insertAt(assembly.mates, m, command.index, 'mates');
      if (!mates.ok) return mates;
      return done({ mates: mates.value }, { type: 'deleteMate', assemblyId, mateId: m.id });
    }

    case 'deleteMate': {
      const i = findMate(command.mateId);
      if (!i.ok) return i;
      const mates = assembly.mates.slice();
      const [old] = mates.splice(i.value, 1);
      return done({ mates }, { type: 'restoreMate', assemblyId, mate: old!, index: i.value });
    }

    case 'suppressMate': {
      const i = findMate(command.mateId);
      if (!i.ok) return i;
      const old = assembly.mates[i.value]!;
      const mates = assembly.mates.slice();
      mates[i.value] = { ...old, suppressed: command.suppressed };
      return done(
        { mates },
        { type: 'suppressMate', assemblyId, mateId: old.id, suppressed: old.suppressed },
      );
    }

    case 'addExplodedView':
    case 'editExplodedView':
    case 'deleteExplodedView':
    case 'restoreExplodedView':
    case 'addExplodeStep':
    case 'editExplodeStep':
    case 'deleteExplodeStep':
    case 'restoreExplodeStep':
      return applyExplodedCommand(assembly, command);
  }
}

type ExplodedCommand = Extract<
  AssemblyCommand,
  {
    type:
      | 'addExplodedView'
      | 'editExplodedView'
      | 'deleteExplodedView'
      | 'restoreExplodedView'
      | 'addExplodeStep'
      | 'editExplodeStep'
      | 'deleteExplodeStep'
      | 'restoreExplodeStep';
  }
>;

const EXPLODED_VIEW_LIST: ListSpec<ExplodedView> = {
  what: 'exploded view',
  plural: 'exploded views',
  idField: 'explodedViewId',
  itemField: 'explodedView',
  ids: explodedViewIds,
  max: MAX_ASSEMBLY_ITEMS,
};
const EXPLODE_STEP_LIST: ListSpec<ExplodeStep> = {
  what: 'step',
  plural: 'steps',
  idField: 'stepId',
  itemField: 'step',
  ids: (step) => [step.id],
  max: MAX_ASSEMBLY_ITEMS,
};

/**
 * Exploded view and step commands. Ids come from the assembly's `nextIds` with the mates' rules:
 * `fresh` for add and edit, `restore` for history. Removing the last exploded view drops
 * `explodedViews`, so an assembly that never had one and one whose views were all removed are the
 * same.
 */
function applyExplodedCommand(
  assembly: Assembly,
  command: ExplodedCommand,
): CoreResult<AssemblyApplied> {
  const { assemblyId } = command;
  const views = assembly.explodedViews ?? [];
  const at = ` in assembly ${assembly.id}`;
  const done = (list: ExplodedView[], nextIds: Record<string, number>, inverse: Command) => {
    const { explodedViews: _old, ...rest } = assembly;
    void _old;
    return ok<AssemblyApplied>({
      assembly:
        list.length === 0 ? { ...rest, nextIds } : { ...rest, explodedViews: list, nextIds },
      inverse,
    });
  };
  const viewInverse = (inv: InverseOp<ExplodedView>): Command =>
    inv.op === 'restore'
      ? { type: 'restoreExplodedView', assemblyId, explodedView: inv.item, index: inv.index }
      : { type: 'deleteExplodedView', assemblyId, explodedViewId: inv.id };

  switch (command.type) {
    case 'addExplodedView':
    case 'editExplodedView':
    case 'deleteExplodedView':
    case 'restoreExplodedView': {
      const op: ListOp<ExplodedView> =
        command.type === 'addExplodedView'
          ? { op: 'add', item: command.explodedView, index: command.index }
          : command.type === 'editExplodedView'
            ? { op: 'edit', item: command.explodedView }
            : command.type === 'restoreExplodedView'
              ? { op: 'restore', item: command.explodedView, index: command.index }
              : { op: 'delete', id: command.explodedViewId };
      const r = applyListOp(views, assembly.nextIds, op, EXPLODED_VIEW_LIST, at);
      if (!r.ok) return r;
      return done(r.value.list, r.value.nextIds, viewInverse(r.value.inverse));
    }

    default: {
      const vi = views.findIndex((v) => v.id === command.explodedViewId);
      const view = views[vi];
      if (!view) {
        return fail('not-found', `No exploded view "${command.explodedViewId}"${at}`, [
          'explodedViewId',
        ]);
      }
      const op: ListOp<ExplodeStep> =
        command.type === 'addExplodeStep'
          ? { op: 'add', item: command.step, index: command.index }
          : command.type === 'editExplodeStep'
            ? { op: 'edit', item: command.step }
            : command.type === 'restoreExplodeStep'
              ? { op: 'restore', item: command.step, index: command.index }
              : { op: 'delete', id: command.stepId };
      const r = applyListOp(view.steps, assembly.nextIds, op, EXPLODE_STEP_LIST, ` in ${view.id}`);
      if (!r.ok) return r;
      const inv = r.value.inverse;
      const explodedViewId = view.id;
      const list = views.slice();
      list[vi] = { ...view, steps: r.value.list };
      return done(
        list,
        r.value.nextIds,
        inv.op === 'restore'
          ? {
              type: 'restoreExplodeStep',
              assemblyId,
              explodedViewId,
              step: inv.item,
              index: inv.index,
            }
          : { type: 'deleteExplodeStep', assemblyId, explodedViewId, stepId: inv.id },
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lists of items with ids, counted by a `nextIds` (exploded views, steps, drawings, sheets,
// views, dimensions, notes): one implementation of add, edit, restore, delete and reorder with
// the id rules of mates and print items, and exact inverses.

interface ListSpec<T> {
  /** `view`, for messages. */
  readonly what: string;
  readonly plural: string;
  /** The command field naming an item by id (`viewId`), and the one holding a whole item. */
  readonly idField: string;
  readonly itemField: string;
  /** Every id an item owns, its own first. */
  readonly ids: (item: T) => string[];
  /** The most items the list may hold. */
  readonly max: number;
}

type ListOp<T> =
  | { op: 'add'; item: T; index?: number | undefined }
  | { op: 'edit'; item: T }
  | { op: 'restore'; item: T; index: number }
  | { op: 'delete'; id: string }
  | { op: 'reorder'; id: string; index: number };

type InverseOp<T> = Extract<ListOp<T>, { op: 'restore' | 'delete' }>;

interface ListApplied<T> {
  list: T[];
  nextIds: Record<string, number>;
  inverse: InverseOp<T>;
}

function applyListOp<T extends { id: string }>(
  list: readonly T[],
  nextIds: Readonly<Record<string, number>>,
  op: Exclude<ListOp<T>, { op: 'reorder' }>,
  spec: ListSpec<T>,
  where: string,
): CoreResult<ListApplied<T>> {
  const full = (): CoreResult<never> | undefined =>
    list.length >= spec.max
      ? fail('schema', `There are already ${spec.max} ${spec.plural}${where}, the most allowed`, [
          spec.itemField,
        ])
      : undefined;
  switch (op.op) {
    case 'add': {
      const { item } = op;
      if (list.some((x) => x.id === item.id)) {
        return fail('duplicate', `${capital(spec.what)} "${item.id}" already exists${where}`, [
          spec.itemField,
          'id',
        ]);
      }
      const tooMany = full();
      if (tooMany) return tooMany;
      const ids = allocate(nextIds, spec.ids(item), { type: 'fresh', before: [], after: [] });
      if (!ids.ok) return ids;
      const out = insertAt(list, item, op.index ?? list.length, spec.plural);
      if (!out.ok) return out;
      return ok({ list: out.value, nextIds: ids.value, inverse: { op: 'delete', id: item.id } });
    }

    case 'edit': {
      const { item } = op;
      const i = list.findIndex((x) => x.id === item.id);
      const old = list[i];
      if (!old)
        return fail('not-found', `No ${spec.what} "${item.id}"${where}`, [spec.itemField, 'id']);
      const before = spec.ids(old);
      const after = spec.ids(item);
      const ids = allocate(nextIds, introducedIds(before, after), { type: 'fresh', before, after });
      if (!ids.ok) return ids;
      const out = list.slice();
      out[i] = item;
      return ok({ list: out, nextIds: ids.value, inverse: { op: 'restore', item: old, index: i } });
    }

    case 'restore': {
      const { item } = op;
      const existing = list.findIndex((x) => x.id === item.id);
      if (existing >= 0) {
        if (existing !== op.index) {
          return fail('invalid-index', `${item.id} is at ${existing}, not ${op.index}`, ['index']);
        }
        const old = list[existing]!;
        const ids = allocate(nextIds, introducedIds(spec.ids(old), spec.ids(item)), {
          type: 'restore',
        });
        if (!ids.ok) return ids;
        const out = list.slice();
        out[existing] = item;
        return ok({
          list: out,
          nextIds: { ...nextIds },
          inverse: { op: 'restore', item: old, index: existing },
        });
      }
      const tooMany = full();
      if (tooMany) return tooMany;
      const ids = allocate(nextIds, spec.ids(item), { type: 'restore' });
      if (!ids.ok) return ids;
      const out = insertAt(list, item, op.index, spec.plural);
      if (!out.ok) return out;
      return ok({
        list: out.value,
        nextIds: { ...nextIds },
        inverse: { op: 'delete', id: item.id },
      });
    }

    case 'delete': {
      const i = list.findIndex((x) => x.id === op.id);
      if (i < 0) return fail('not-found', `No ${spec.what} "${op.id}"${where}`, [spec.idField]);
      const out = list.slice();
      const [old] = out.splice(i, 1);
      return ok({
        list: out,
        nextIds: { ...nextIds },
        inverse: { op: 'restore', item: old!, index: i },
      });
    }
  }
}

/** Moves item `id` so it ends up at `index`; the inverse moves it back. */
function reorderList<T extends { id: string }>(
  list: readonly T[],
  id: string,
  index: number,
  spec: ListSpec<T>,
  where: string,
): CoreResult<{ list: T[]; from: number }> {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return fail('not-found', `No ${spec.what} "${id}"${where}`, [spec.idField]);
  if (index >= list.length) {
    return fail(
      'invalid-index',
      `Index ${index} is past the last of ${list.length} ${spec.plural}`,
      ['index'],
    );
  }
  const out = list.slice();
  const [moved] = out.splice(i, 1);
  out.splice(index, 0, moved!);
  return ok({ list: out, from: i });
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Print items, in any setup, that print part `partId`, as `<setup id>/<item id>`. Only the part
 * blocks a delete; the bodies and faces an item names never do (ADR 0012 decision 2).
 */
export function partPrintItems(doc: ManufaktureDocument, partId: string): string[] {
  const out: string[] = [];
  for (const setup of doc.print.setups) {
    for (const item of setup.items) {
      if (item.part === partId) out.push(`${setup.id}/${item.id}`);
    }
  }
  return out;
}

type PrintCommand = Extract<
  SimpleCommand,
  {
    type:
      | 'addPrintSetup'
      | 'editPrintSetup'
      | 'deletePrintSetup'
      | 'restorePrintSetup'
      | 'addPrintItem'
      | 'editPrintItem'
      | 'deletePrintItem'
      | 'restorePrintItem';
  }
>;

/**
 * Commands on the print section. Ids come from `print.nextIds` with the same rules as a part's:
 * `fresh` for add and edit, `restore` for history. Nothing here looks at geometry, so no print
 * command can be refused because of what a body or face reference names.
 */
function applyToPrint(doc: ManufaktureDocument, command: PrintCommand): CoreResult<Applied> {
  const print = doc.print;
  const done = (changes: Partial<PrintData>, inverse: Command) =>
    ok<Applied>({ document: { ...doc, print: { ...print, ...changes } }, inverse });
  const findSetup = (id: string): CoreResult<number> => {
    const i = print.setups.findIndex((x) => x.id === id);
    return i < 0 ? fail('not-found', `No print setup "${id}"`, ['setupId']) : ok(i);
  };
  const withSetup = (si: number, setup: PrintSetup): PrintSetup[] => {
    const setups = print.setups.slice();
    setups[si] = setup;
    return setups;
  };

  switch (command.type) {
    case 'addPrintSetup':
    case 'restorePrintSetup': {
      const setup = command.setup;
      if (print.setups.some((x) => x.id === setup.id)) {
        return fail('duplicate', `Print setup "${setup.id}" already exists`, ['setup', 'id']);
      }
      const restore = command.type === 'restorePrintSetup';
      const ids = allocate(
        print.nextIds,
        printSetupIds(setup),
        restore ? { type: 'restore' } : { type: 'fresh', before: [], after: [] },
      );
      if (!ids.ok) return ids;
      const setups = insertAt(
        print.setups,
        setup,
        command.index ?? print.setups.length,
        'print setups',
      );
      if (!setups.ok) return setups;
      return done(
        { setups: setups.value, nextIds: ids.value },
        { type: 'deletePrintSetup', setupId: setup.id },
      );
    }

    case 'editPrintSetup': {
      const si = findSetup(command.setupId);
      if (!si.ok) return si;
      const old = print.setups[si.value]!;
      let next: PrintSetup = old;
      const inverse: Extract<SimpleCommand, { type: 'editPrintSetup' }> = {
        type: 'editPrintSetup',
        setupId: old.id,
      };
      if (command.name !== undefined) {
        const name = command.name.trim();
        if (name.length === 0 || name.length > MAX_PRINT_SETUP_NAME) {
          return fail(
            'invalid-name',
            `A print setup name must be 1 to ${MAX_PRINT_SETUP_NAME} characters`,
            ['name'],
          );
        }
        next = { ...next, name };
        inverse.name = old.name;
      }
      if (command.printer !== undefined) {
        next = { ...next, printer: command.printer };
        inverse.printer = old.printer;
      }
      if (command.nozzle !== undefined) {
        next = { ...next, nozzle: command.nozzle };
        inverse.nozzle = old.nozzle;
      }
      if (command.thresholds !== undefined) {
        const { thresholds: _thresholds, ...rest } = next;
        void _thresholds;
        next = command.thresholds === null ? rest : { ...rest, thresholds: command.thresholds };
        inverse.thresholds = old.thresholds ?? null;
      }
      return done({ setups: withSetup(si.value, next) }, inverse);
    }

    case 'deletePrintSetup': {
      const si = findSetup(command.setupId);
      if (!si.ok) return si;
      const setups = print.setups.slice();
      const [old] = setups.splice(si.value, 1);
      return done({ setups }, { type: 'restorePrintSetup', setup: old!, index: si.value });
    }

    case 'addPrintItem':
    case 'editPrintItem':
    case 'deletePrintItem':
    case 'restorePrintItem': {
      const si = findSetup(command.setupId);
      if (!si.ok) return si;
      const r = applyPrintItemCommand(print, print.setups[si.value]!, command);
      if (!r.ok) return r;
      return done(
        { setups: withSetup(si.value, r.value.setup), nextIds: r.value.nextIds },
        r.value.inverse,
      );
    }
  }
}

function applyPrintItemCommand(
  print: PrintData,
  setup: PrintSetup,
  command: Extract<
    PrintCommand,
    { type: 'addPrintItem' | 'editPrintItem' | 'deletePrintItem' | 'restorePrintItem' }
  >,
): CoreResult<{ setup: PrintSetup; nextIds: Record<string, number>; inverse: Command }> {
  const { setupId } = command;
  const done = (items: PrintItem[], inverse: Command, nextIds = print.nextIds) =>
    ok({ setup: { ...setup, items }, nextIds, inverse });
  const findItem = (id: string): CoreResult<number> => {
    const i = setup.items.findIndex((x) => x.id === id);
    return i < 0
      ? fail('not-found', `No item "${id}" in print setup ${setup.id}`, ['itemId'])
      : ok(i);
  };

  switch (command.type) {
    case 'addPrintItem': {
      const item = command.item;
      // Item ids are unique across setups; validation reports a clash with another setup's.
      if (setup.items.some((x) => x.id === item.id)) {
        return fail('duplicate', `Print item "${item.id}" already exists`, ['item', 'id']);
      }
      const ids = allocate(print.nextIds, printItemIds(item), {
        type: 'fresh',
        before: [],
        after: [],
      });
      if (!ids.ok) return ids;
      const items = insertAt(setup.items, item, command.index ?? setup.items.length, 'items');
      if (!items.ok) return items;
      return done(items.value, { type: 'deletePrintItem', setupId, itemId: item.id }, ids.value);
    }

    case 'editPrintItem': {
      const item = command.item;
      const i = findItem(item.id);
      if (!i.ok) return i;
      const old = setup.items[i.value]!;
      const before = printItemIds(old);
      const after = printItemIds(item);
      const ids = allocate(print.nextIds, introducedIds(before, after), {
        type: 'fresh',
        before,
        after,
      });
      if (!ids.ok) return ids;
      const items = setup.items.slice();
      items[i.value] = item;
      return done(
        items,
        { type: 'restorePrintItem', setupId, item: old, index: i.value },
        ids.value,
      );
    }

    case 'restorePrintItem': {
      const item = command.item;
      const existing = setup.items.findIndex((x) => x.id === item.id);
      if (existing >= 0) {
        if (existing !== command.index) {
          return fail('invalid-index', `${item.id} is at ${existing}, not ${command.index}`, [
            'index',
          ]);
        }
        const old = setup.items[existing]!;
        const ids = allocate(print.nextIds, introducedIds(printItemIds(old), printItemIds(item)), {
          type: 'restore',
        });
        if (!ids.ok) return ids;
        const items = setup.items.slice();
        items[existing] = item;
        return done(items, { type: 'restorePrintItem', setupId, item: old, index: existing });
      }
      const ids = allocate(print.nextIds, printItemIds(item), { type: 'restore' });
      if (!ids.ok) return ids;
      const items = insertAt(setup.items, item, command.index, 'items');
      if (!items.ok) return items;
      return done(items.value, { type: 'deletePrintItem', setupId, itemId: item.id });
    }

    case 'deletePrintItem': {
      const i = findItem(command.itemId);
      if (!i.ok) return i;
      const items = setup.items.slice();
      const [old] = items.splice(i.value, 1);
      return done(items, { type: 'restorePrintItem', setupId, item: old!, index: i.value });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Drawings (since version 12)

/** Longest drawing name `renameDrawing` accepts (as for features). */
export const MAX_DRAWING_NAME = 200;

/** Drawing views, in any drawing, whose source passes `test`, as `<drawing>/<sheet>/<view>`. */
function viewsWhere(doc: ManufaktureDocument, test: (view: DrawingView) => boolean): string[] {
  const out: string[] = [];
  forEachView(doc.drawings, (view, sheet, drawing) => {
    if (test(view)) out.push(`${drawing.id}/${sheet.id}/${view.id}`);
  });
  return out;
}

/** Drawing views that show part `partId`, as `<drawing id>/<sheet id>/<view id>`. */
export function partViews(doc: ManufaktureDocument, partId: string): string[] {
  return viewsWhere(doc, (v) => 'part' in v.source && v.source.part === partId);
}

/** Drawing views that show assembly `assemblyId`, assembled or exploded. */
export function assemblyViews(doc: ManufaktureDocument, assemblyId: string): string[] {
  return viewsWhere(doc, (v) => 'assembly' in v.source && v.source.assembly === assemblyId);
}

/** Drawing views that show exploded view `explodedViewId` of assembly `assemblyId`. */
export function explodedViewViews(
  doc: ManufaktureDocument,
  assemblyId: string,
  explodedViewId: string,
): string[] {
  return viewsWhere(
    doc,
    (v) =>
      'assembly' in v.source &&
      v.source.assembly === assemblyId &&
      v.source.explodedView === explodedViewId,
  );
}

/**
 * Dimensions, in any drawing, that measure instance `instanceId` of assembly `assemblyId` (in a
 * view of that assembly), as `<drawing id>/<sheet id>/<dimension id>`.
 */
export function instanceDimensions(
  doc: ManufaktureDocument,
  assemblyId: string,
  instanceId: string,
): string[] {
  const out: string[] = [];
  for (const drawing of doc.drawings ?? []) {
    for (const sheet of drawing.sheets) {
      const views = new Set(
        sheet.views
          .filter((v) => 'assembly' in v.source && v.source.assembly === assemblyId)
          .map((v) => v.id),
      );
      if (views.size === 0) continue;
      for (const d of sheet.dimensions) {
        if (views.has(d.view) && dimensionInstances(d).includes(instanceId)) {
          out.push(`${drawing.id}/${sheet.id}/${d.id}`);
        }
      }
    }
  }
  return out;
}

type DrawingsCommand = Extract<
  SimpleCommand,
  {
    type:
      | 'addDrawing'
      | 'renameDrawing'
      | 'deleteDrawing'
      | 'restoreDrawing'
      | 'reorderDrawings'
      | 'addSheet'
      | 'editSheet'
      | 'deleteSheet'
      | 'restoreSheet'
      | 'reorderSheets'
      | 'addView'
      | 'editView'
      | 'moveView'
      | 'deleteView'
      | 'restoreView'
      | 'addDimension'
      | 'editDimension'
      | 'deleteDimension'
      | 'restoreDimension'
      | 'addNote'
      | 'editNote'
      | 'deleteNote'
      | 'restoreNote';
  }
>;

type DrawingCommand = Exclude<
  DrawingsCommand,
  { type: 'addDrawing' | 'renameDrawing' | 'deleteDrawing' | 'restoreDrawing' | 'reorderDrawings' }
>;
type SheetItemCommand = Exclude<
  DrawingCommand,
  { type: 'addSheet' | 'editSheet' | 'deleteSheet' | 'restoreSheet' | 'reorderSheets' }
>;

const DRAWING_LIST: ListSpec<Drawing> = {
  what: 'drawing',
  plural: 'drawings',
  idField: 'drawingId',
  itemField: 'drawing',
  ids: (d) => [d.id],
  max: MAX_DRAWING_ITEMS,
};
const SHEET_LIST: ListSpec<Sheet> = {
  what: 'sheet',
  plural: 'sheets',
  idField: 'sheetId',
  itemField: 'sheet',
  ids: sheetIds,
  max: MAX_DRAWING_ITEMS,
};
const VIEW_LIST: ListSpec<DrawingView> = {
  what: 'view',
  plural: 'views',
  idField: 'viewId',
  itemField: 'view',
  ids: (v) => [v.id],
  max: MAX_DRAWING_ITEMS,
};
const DIMENSION_LIST: ListSpec<Dimension> = {
  what: 'dimension',
  plural: 'dimensions',
  idField: 'dimensionId',
  itemField: 'dimension',
  ids: (d) => [d.id],
  max: MAX_DRAWING_ITEMS,
};
const NOTE_LIST: ListSpec<Note> = {
  what: 'note',
  plural: 'notes',
  idField: 'noteId',
  itemField: 'note',
  ids: (n) => [n.id],
  max: MAX_DRAWING_ITEMS,
};

/** `doc` with `drawings`; an empty list drops the key, so undo of the first add is exact. */
function withDrawings(
  doc: ManufaktureDocument,
  drawings: Drawing[],
  nextIds = doc.nextIds,
): ManufaktureDocument {
  const { drawings: _old, ...rest } = doc;
  void _old;
  return drawings.length === 0 ? { ...rest, nextIds } : { ...rest, drawings, nextIds };
}

/**
 * Commands on drawings. Drawing ids come from the document's `nextIds.drawing`; ids inside a
 * drawing from the drawing's own `nextIds`, with the rules of mates and print items: `fresh` for
 * add and edit, `restore` for history. A dimension's model references are never looked at, so no
 * drawing command is refused because of what a body, face, edge or vertex names.
 */
function applyToDrawings(doc: ManufaktureDocument, command: DrawingsCommand): CoreResult<Applied> {
  const drawings = doc.drawings ?? [];
  const drawingInverse = (inv: InverseOp<Drawing>): Command =>
    inv.op === 'restore'
      ? { type: 'restoreDrawing', drawing: inv.item, index: inv.index }
      : { type: 'deleteDrawing', drawingId: inv.id };

  switch (command.type) {
    case 'addDrawing':
    case 'restoreDrawing': {
      const d = command.drawing;
      const restore = command.type === 'restoreDrawing';
      if (!DRAWING_ID_PATTERN.test(d.id)) {
        return fail('invalid-id', `"${d.id}" is not a drawing id (drawing#n)`, ['drawing', 'id'], {
          blockers: [d.id],
        });
      }
      if (drawings.some((x) => x.id === d.id)) {
        return fail('duplicate', `Drawing "${d.id}" already exists`, ['drawing', 'id']);
      }
      if (drawings.length >= MAX_DRAWING_ITEMS) {
        return fail(
          'schema',
          `The document already holds ${MAX_DRAWING_ITEMS} drawings, the most allowed`,
          ['drawing'],
        );
      }
      const ids = allocateDocumentId(doc, DRAWING_COUNTER, d.id, restore ? 'restore' : 'fresh');
      if (!ids.ok) return ids;
      const list = insertAt(
        drawings,
        d,
        restore ? command.index : (command.index ?? drawings.length),
        'drawings',
      );
      if (!list.ok) return list;
      return ok({
        document: withDrawings(doc, list.value, ids.value),
        inverse: { type: 'deleteDrawing', drawingId: d.id },
      });
    }

    case 'deleteDrawing': {
      const r = applyListOp(
        drawings,
        {},
        { op: 'delete', id: command.drawingId },
        DRAWING_LIST,
        '',
      );
      if (!r.ok) return r;
      return ok({
        document: withDrawings(doc, r.value.list),
        inverse: drawingInverse(r.value.inverse),
      });
    }

    case 'reorderDrawings': {
      const r = reorderList(drawings, command.drawingId, command.index, DRAWING_LIST, '');
      if (!r.ok) return r;
      return ok({
        document: withDrawings(doc, r.value.list),
        inverse: { type: 'reorderDrawings', drawingId: command.drawingId, index: r.value.from },
      });
    }

    default: {
      const di = drawings.findIndex((d) => d.id === command.drawingId);
      const drawing = drawings[di];
      if (!drawing) return fail('not-found', `No drawing "${command.drawingId}"`, ['drawingId']);
      const r =
        command.type === 'renameDrawing'
          ? renameDrawing(drawing, command.name)
          : applyDrawingCommand(drawing, command);
      if (!r.ok) return r;
      const list = drawings.slice();
      list[di] = r.value.drawing;
      return ok({ document: withDrawings(doc, list), inverse: r.value.inverse });
    }
  }
}

interface DrawingApplied {
  drawing: Drawing;
  inverse: Command;
}

function renameDrawing(drawing: Drawing, raw: string): CoreResult<DrawingApplied> {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_DRAWING_NAME) {
    return fail('invalid-name', `A drawing name must be 1 to ${MAX_DRAWING_NAME} characters`, [
      'name',
    ]);
  }
  return ok({
    drawing: { ...drawing, name },
    inverse: { type: 'renameDrawing', drawingId: drawing.id, name: drawing.name },
  });
}

/** Commands on the sheets of one drawing, and on what is on them. */
function applyDrawingCommand(
  drawing: Drawing,
  command: DrawingCommand,
): CoreResult<DrawingApplied> {
  const { drawingId } = command;
  const at = ` in drawing ${drawing.id}`;
  const done = (sheets: Sheet[], inverse: Command, nextIds = drawing.nextIds) =>
    ok<DrawingApplied>({ drawing: { ...drawing, sheets, nextIds }, inverse });
  const sheetInverse = (inv: InverseOp<Sheet>): Command =>
    inv.op === 'restore'
      ? { type: 'restoreSheet', drawingId, sheet: inv.item, index: inv.index }
      : { type: 'deleteSheet', drawingId, sheetId: inv.id };

  switch (command.type) {
    case 'addSheet':
    case 'deleteSheet':
    case 'restoreSheet': {
      const op: Exclude<ListOp<Sheet>, { op: 'reorder' }> = command.type === 'addSheet'
        ? { op: 'add', item: command.sheet, index: command.index }
        : command.type === 'restoreSheet'
          ? { op: 'restore', item: command.sheet, index: command.index }
          : { op: 'delete', id: command.sheetId };
      if (op.op === 'restore' && drawing.sheets.some((x) => x.id === op.item.id)) {
        // A sheet is replaced field by field with `editSheet`; restore only puts one back.
        return fail('duplicate', `Sheet "${op.item.id}" already exists${at}`, ['sheet', 'id']);
      }
      const r = applyListOp(drawing.sheets, drawing.nextIds, op, SHEET_LIST, at);
      if (!r.ok) return r;
      return done(r.value.list, sheetInverse(r.value.inverse), r.value.nextIds);
    }

    case 'reorderSheets': {
      const r = reorderList(drawing.sheets, command.sheetId, command.index, SHEET_LIST, at);
      if (!r.ok) return r;
      return done(r.value.list, {
        type: 'reorderSheets',
        drawingId,
        sheetId: command.sheetId,
        index: r.value.from,
      });
    }

    default: {
      const si = drawing.sheets.findIndex((x) => x.id === command.sheetId);
      const sheet = drawing.sheets[si];
      if (!sheet) return fail('not-found', `No sheet "${command.sheetId}"${at}`, ['sheetId']);
      const r =
        command.type === 'editSheet'
          ? editSheet(sheet, command)
          : applySheetItemCommand(drawing, sheet, command);
      if (!r.ok) return r;
      const sheets = drawing.sheets.slice();
      sheets[si] = r.value.sheet;
      return done(sheets, r.value.inverse, r.value.nextIds ?? drawing.nextIds);
    }
  }
}

interface SheetApplied {
  sheet: Sheet;
  inverse: Command;
  nextIds?: Record<string, number>;
}

function editSheet(
  sheet: Sheet,
  command: Extract<SimpleCommand, { type: 'editSheet' }>,
): CoreResult<SheetApplied> {
  let next: Sheet = sheet;
  const inverse: Extract<SimpleCommand, { type: 'editSheet' }> = {
    type: 'editSheet',
    drawingId: command.drawingId,
    sheetId: sheet.id,
  };
  if (command.name !== undefined) {
    const name = command.name.trim();
    if (name.length === 0 || name.length > MAX_DRAWING_NAME) {
      return fail('invalid-name', `A sheet name must be 1 to ${MAX_DRAWING_NAME} characters`, [
        'name',
      ]);
    }
    next = { ...next, name };
    inverse.name = sheet.name;
  }
  if (command.size !== undefined) {
    next = { ...next, size: command.size };
    inverse.size = sheet.size;
  }
  if (command.orientation !== undefined) {
    next = { ...next, orientation: command.orientation };
    inverse.orientation = sheet.orientation;
  }
  if (command.titleBlock !== undefined) {
    const { titleBlock: _old, ...rest } = next;
    void _old;
    next = command.titleBlock === null ? rest : { ...rest, titleBlock: command.titleBlock };
    inverse.titleBlock = sheet.titleBlock ?? null;
  }
  return ok({ sheet: next, inverse });
}

/** Commands on the views, dimensions and notes of one sheet. */
function applySheetItemCommand(
  drawing: Drawing,
  sheet: Sheet,
  command: SheetItemCommand,
): CoreResult<SheetApplied> {
  const { drawingId, sheetId } = command;
  const at = ` on sheet ${sheet.id} of ${drawing.id}`;
  const item = <T>(
    r: CoreResult<ListApplied<T>>,
    changes: (list: T[]) => Partial<Sheet>,
    inverse: (inv: InverseOp<T>) => Command,
  ): CoreResult<SheetApplied> =>
    r.ok
      ? ok({
          sheet: { ...sheet, ...changes(r.value.list) },
          inverse: inverse(r.value.inverse),
          nextIds: r.value.nextIds,
        })
      : r;

  switch (command.type) {
    case 'moveView': {
      const vi = sheet.views.findIndex((v) => v.id === command.viewId);
      const old = sheet.views[vi];
      if (!old) return fail('not-found', `No view "${command.viewId}"${at}`, ['viewId']);
      const views = sheet.views.slice();
      views[vi] = { ...old, position: command.position };
      return ok({
        sheet: { ...sheet, views },
        inverse: { type: 'moveView', drawingId, sheetId, viewId: old.id, position: old.position },
      });
    }

    case 'addView':
    case 'editView':
    case 'deleteView':
    case 'restoreView': {
      if (command.type === 'deleteView') {
        const users = [
          ...sheet.dimensions.filter((d) => d.view === command.viewId).map((d) => d.id),
          ...sheet.notes.filter((n) => n.view === command.viewId).map((n) => n.id),
        ];
        if (users.length > 0) {
          return fail(
            'dependency',
            `Cannot delete ${command.viewId}: ${users.join(', ')} ${users.length === 1 ? 'is' : 'are'} in it`,
            ['viewId'],
            { blockers: users },
          );
        }
      }
      const op: Exclude<ListOp<DrawingView>, { op: 'reorder' }> = command.type === 'addView'
        ? { op: 'add', item: command.view, index: command.index }
        : command.type === 'editView'
          ? { op: 'edit', item: command.view }
          : command.type === 'restoreView'
            ? { op: 'restore', item: command.view, index: command.index }
            : { op: 'delete', id: command.viewId };
      return item(
        applyListOp(sheet.views, drawing.nextIds, op, VIEW_LIST, at),
        (views) => ({ views }),
        (inv) =>
          inv.op === 'restore'
            ? { type: 'restoreView', drawingId, sheetId, view: inv.item, index: inv.index }
            : { type: 'deleteView', drawingId, sheetId, viewId: inv.id },
      );
    }

    case 'addDimension':
    case 'editDimension':
    case 'deleteDimension':
    case 'restoreDimension': {
      const op: Exclude<ListOp<Dimension>, { op: 'reorder' }> = command.type === 'addDimension'
        ? { op: 'add', item: command.dimension, index: command.index }
        : command.type === 'editDimension'
          ? { op: 'edit', item: command.dimension }
          : command.type === 'restoreDimension'
            ? { op: 'restore', item: command.dimension, index: command.index }
            : { op: 'delete', id: command.dimensionId };
      return item(
        applyListOp(sheet.dimensions, drawing.nextIds, op, DIMENSION_LIST, at),
        (dimensions) => ({ dimensions }),
        (inv) =>
          inv.op === 'restore'
            ? {
                type: 'restoreDimension',
                drawingId,
                sheetId,
                dimension: inv.item,
                index: inv.index,
              }
            : { type: 'deleteDimension', drawingId, sheetId, dimensionId: inv.id },
      );
    }

    case 'addNote':
    case 'editNote':
    case 'deleteNote':
    case 'restoreNote': {
      const op: Exclude<ListOp<Note>, { op: 'reorder' }> = command.type === 'addNote'
        ? { op: 'add', item: command.note, index: command.index }
        : command.type === 'editNote'
          ? { op: 'edit', item: command.note }
          : command.type === 'restoreNote'
            ? { op: 'restore', item: command.note, index: command.index }
            : { op: 'delete', id: command.noteId };
      return item(
        applyListOp(sheet.notes, drawing.nextIds, op, NOTE_LIST, at),
        (notes) => ({ notes }),
        (inv) =>
          inv.op === 'restore'
            ? { type: 'restoreNote', drawingId, sheetId, note: inv.item, index: inv.index }
            : { type: 'deleteNote', drawingId, sheetId, noteId: inv.id },
      );
    }
  }
}

/** Drawings whose expressions (custom sheet sizes, view scales, section offsets) mention `name`. */
export function variableDrawings(doc: ManufaktureDocument, name: string): Drawing[] {
  return (doc.drawings ?? []).filter((d) =>
    drawingExpressions(d).some((s) => expressionVariableNames(s.expression).includes(name)),
  );
}

/** Exploded views whose step distances mention variable `name`, by assembly. */
export function variableExplodedViews(
  doc: ManufaktureDocument,
  name: string,
): { assemblyId: string; explodedView: ExplodedView }[] {
  const out: { assemblyId: string; explodedView: ExplodedView }[] = [];
  for (const assembly of doc.assemblies) {
    for (const explodedView of assembly.explodedViews ?? []) {
      const reads = explodedViewExpressions(explodedView).some((s) =>
        expressionVariableNames(s.expression).includes(name),
      );
      if (reads) out.push({ assemblyId: assembly.id, explodedView });
    }
  }
  return out;
}

/** Print setups whose expressions (thresholds, item orientations) mention variable `name`. */
export function variablePrintSetups(doc: ManufaktureDocument, name: string): PrintSetup[] {
  return doc.print.setups.filter((setup) =>
    printSetupExpressions(setup).some((s) => expressionVariableNames(s.expression).includes(name)),
  );
}

/** Mates whose expressions (connector offsets, limits) mention variable `name`, by mate. */
export function variableMates(
  doc: ManufaktureDocument,
  name: string,
): { assemblyId: string; mate: Mate }[] {
  const out: { assemblyId: string; mate: Mate }[] = [];
  for (const assembly of doc.assemblies) {
    for (const mate of assembly.mates) {
      if (mateExpressions(mate).some((s) => expressionVariableNames(s.expression).includes(name)))
        out.push({ assemblyId: assembly.id, mate });
    }
  }
  return out;
}

/** Configuration parameters that name variable `name`. */
export function variableParameters(
  doc: ManufaktureDocument,
  name: string,
): Extract<ConfigParameter, { kind: 'variable' }>[] {
  return (doc.configurations?.parameters ?? []).filter(
    (p): p is Extract<ConfigParameter, { kind: 'variable' }> =>
      p.kind === 'variable' && p.variable === name,
  );
}

/**
 * Variables, features, mates, print setups, exploded views, drawings, configuration parameters
 * and configuration rows that use variable `name`: expressions that mention it (a mate as
 * `<assembly id>/<mate id>`, a print setup by its id, for its thresholds and its items'
 * orientations, an exploded view as `<assembly id>/<exploded view id>` for its step distances, a
 * drawing by its id for its sheet sizes, view scales and section offsets), parameters that
 * configure it, and rows with a value that mentions it.
 */
export function variableUsers(doc: ManufaktureDocument, name: string): string[] {
  const users: string[] = [];
  for (const v of doc.variables) {
    if (v.name !== name && expressionVariableNames(v.expression).includes(name)) users.push(v.name);
  }
  for (const part of doc.parts) {
    for (const f of part.features) {
      if (featureExpressions(f).some((s) => expressionVariableNames(s.expression).includes(name)))
        users.push(f.id);
    }
  }
  for (const { assemblyId, mate } of variableMates(doc, name)) {
    users.push(`${assemblyId}/${mate.id}`);
  }
  for (const setup of variablePrintSetups(doc, name)) users.push(setup.id);
  for (const { assemblyId, explodedView } of variableExplodedViews(doc, name)) {
    users.push(`${assemblyId}/${explodedView.id}`);
  }
  for (const drawing of variableDrawings(doc, name)) users.push(drawing.id);
  for (const p of variableParameters(doc, name)) users.push(p.id);
  for (const row of doc.configurations?.rows ?? []) {
    const mentions = Object.values(row.values).some(
      (v) => typeof v === 'object' && expressionVariableNames(v).includes(name),
    );
    if (mentions) users.push(row.id);
  }
  return users;
}

function deleteVariable(doc: ManufaktureDocument, name: string): CoreResult<Applied> {
  const i = doc.variables.findIndex((v) => v.name === name);
  const old = doc.variables[i];
  if (!old) return fail('not-found', `No variable "${name}"`, ['name']);
  const users = variableUsers(doc, name);
  if (users.length > 0) {
    return fail(
      'variable-in-use',
      `Cannot delete "${name}": used by ${users.join(', ')}`,
      ['name'],
      { blockers: users },
    );
  }
  const variables = doc.variables.slice();
  variables.splice(i, 1);
  return ok({
    document: { ...doc, variables },
    inverse: { type: 'setVariable', name, expression: old.expression, index: i },
  });
}
