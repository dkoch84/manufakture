// One readable line per command (ADR 0016 decision 11: "a readable summary per command type"):
// `SUMMARIES` has an entry for every command type core knows, which the type checker enforces
// and `summaries.test.ts` checks against core's schema, so a new command type fails the build
// until it has one. Each takes the command and the documents before and after it, for names
// and for what an edit changed.

import {
  mechItems,
  type Command,
  type CommandType,
  type ManufaktureDocument,
  type MechList,
} from '@manufakture/core';
import { describeFeature, featureTitle, materialName, type Names } from './describe';
import { domainLines, type DomainSummariser } from './domains';
import { an, expressionText, fieldChanges, omit, plural, shown, valueText } from './text';
import type { FieldChange } from './types';

export interface SummaryContext {
  /** The document before the command (null when the replay could not make it). */
  before: ManufaktureDocument | null;
  after: ManufaktureDocument | null;
  names: Names;
  summarisers: ReadonlyMap<string, DomainSummariser>;
}

type Of<K extends CommandType> = Extract<Command, { type: K }>;
type Summariser<K extends CommandType> = (command: Of<K>, ctx: SummaryContext) => string;

/** "radius 4 mm to 2 mm, name Fillet 1 to Round" for the first few fields; "+2 more". */
export function changesText(changes: readonly FieldChange[], max = 3): string {
  if (changes.length === 0) return 'no change';
  const shownChanges = changes
    .slice(0, max)
    .map((c) => `${c.path} ${c.before} to ${c.after}`)
    .join(', ');
  return changes.length > max ? `${shownChanges}, and ${changes.length - max} more` : shownChanges;
}

/** Lines of a source: a final line break ends the last line rather than starting another. */
export const lineCount = (source: string): number =>
  source.length === 0 ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);

const inPart = (ctx: SummaryContext, partId: string): string =>
  ctx.names.manyParts ? ` in ${ctx.names.part(partId)}` : '';

const position = (index: number | undefined): string =>
  index === undefined ? '' : ` at position ${index + 1}`;

function featureBefore(ctx: SummaryContext, partId: string, featureId: string) {
  return ctx.before?.parts.find((p) => p.id === partId)?.features.find((f) => f.id === featureId);
}

function edited(before: unknown, after: unknown, skip: readonly string[] = ['id']): string {
  return changesText(fieldChanges(before, after, { skip }));
}

const PARAMETER = (p: Of<'setConfigParameter'>['parameter'], ctx: SummaryContext): string =>
  p.kind === 'variable'
    ? `${shown(p.name)} (variable ${shown(p.variable, 80)})`
    : `${shown(p.name)} (suppression of ${ctx.names.feature(p.partId, p.featureId)})`;

/** A mechanical item as a reviewer reads it: its name (or what identifies it) and id. */
function mechLabel(item: { id: string; name?: string } & Record<string, unknown>): string {
  const what =
    typeof item.name === 'string'
      ? item.name
      : typeof item.check === 'string'
        ? item.check
        : typeof item.test === 'string'
          ? item.test
          : typeof item.partNumber === 'string'
            ? `${String(item.maker)} ${item.partNumber}`
            : typeof item.spec === 'string'
              ? `${item.spec} ${String(item.field)}`
              : undefined;
  return what === undefined ? shown(item.id, 40) : `${shown(what)} (${shown(item.id, 40)})`;
}

/** "Added load case ..." or "Changed load case ...: fields", from the document before. */
function mechSet(
  list: MechList,
  what: string,
  item: { id: string; name?: string },
  ctx: SummaryContext,
): string {
  const old = (mechItems(ctx.before?.mech, list) as readonly { id: string }[]).find(
    (x) => x.id === item.id,
  );
  const label = mechLabel(item as { id: string } & Record<string, unknown>);
  return old === undefined
    ? `Added ${what} ${label}`
    : `Changed ${what} ${label}: ${edited(old, item)}`;
}

/** The name of a mechanical item the document before has, else its id. */
function mechNamed(list: MechList, id: string, ctx: SummaryContext): string {
  const old = (
    mechItems(ctx.before?.mech, list) as readonly ({ id: string } & Record<string, unknown>)[]
  ).find((x) => x.id === id);
  return old === undefined ? shown(id, 40) : mechLabel(old);
}

export const SUMMARIES: { [K in CommandType]: Summariser<K> } = {
  addFeature: (c, ctx) =>
    `Added ${describeFeature(c.feature, ctx.names, c.partId)}${inPart(ctx, c.partId)}`,
  editFeature: (c, ctx) => {
    const old = featureBefore(ctx, c.partId, c.feature.id);
    return `Edited ${featureTitle(c.feature)}${inPart(ctx, c.partId)}: ${
      old === undefined
        ? describeFeature(c.feature, ctx.names, c.partId)
        : edited(old, c.feature, ['id', 'kind'])
    }`;
  },
  deleteFeature: (c, ctx) => {
    const old = featureBefore(ctx, c.partId, c.featureId);
    return `Deleted ${old ? featureTitle(old) : ctx.names.feature(c.partId, c.featureId)}${inPart(ctx, c.partId)}`;
  },
  restoreFeature: (c, ctx) =>
    `Restored ${describeFeature(c.feature, ctx.names, c.partId)}${position(c.index)}${inPart(ctx, c.partId)}`,
  reorderFeature: (c, ctx) =>
    `Moved ${ctx.names.feature(c.partId, c.featureId)}${position(c.index)} in the feature list${inPart(ctx, c.partId)}`,
  suppressFeature: (c, ctx) =>
    `${c.suppressed ? 'Suppressed' : 'Unsuppressed'} ${ctx.names.feature(c.partId, c.featureId)}${inPart(ctx, c.partId)}`,
  renameFeature: (c, ctx) =>
    `Renamed ${ctx.names.feature(c.partId, c.featureId)} to ${shown(c.name)}${inPart(ctx, c.partId)}`,
  setMaterial: (c, ctx) =>
    c.material === null
      ? `Cleared the material of ${ctx.names.part(c.partId)}`
      : `Set the material of ${ctx.names.part(c.partId)} to ${materialName(c.material)}`,
  setBodyProps: (c, ctx) => {
    const p = c.props;
    const parts = [
      p.name !== undefined ? `name ${shown(p.name)}` : null,
      p.color !== undefined ? `colour ${shown(p.color, 20)}` : null,
      p.material !== undefined ? `material ${materialName(p.material)}` : null,
    ].filter((x) => x !== null);
    return `Set body ${shown(c.bodyId, 120)} of ${ctx.names.part(c.partId)}: ${parts.length > 0 ? parts.join(', ') : 'cleared'}`;
  },
  setBodyGroup: (c, ctx) =>
    `Set body group ${shown(c.group.name)} (${plural(c.group.bodies.length, 'body', 'bodies')}) in ${ctx.names.part(c.partId)}`,
  deleteBodyGroup: (c, ctx) =>
    `Deleted body group ${ctx.names.bodyGroup(c.partId, c.groupId)} in ${ctx.names.part(c.partId)}`,
  restoreBodyGroup: (c, ctx) =>
    `Restored body group ${shown(c.group.name)} in ${ctx.names.part(c.partId)}`,
  setRollback: (c, ctx) =>
    c.index === null
      ? `Moved the rollback bar of ${ctx.names.part(c.partId)} to the end`
      : `Moved the rollback bar of ${ctx.names.part(c.partId)} to after ${plural(c.index, 'feature')}`,
  setVariable: (c, ctx) => {
    const old = ctx.before?.variables.find((v) => v.name === c.name)?.expression;
    return old === undefined
      ? `Added variable ${shown(c.name, 80)} = ${expressionText(c.expression)}`
      : `Set variable ${shown(c.name, 80)} from ${expressionText(old)} to ${expressionText(c.expression)}`;
  },
  deleteVariable: (c) => `Deleted variable ${shown(c.name, 80)}`,
  setDisplayUnits: (c) =>
    `Set the display units to ${c.units.length.unit} and ${c.units.angle.unit} (display only)`,
  renameDocument: (c, ctx) =>
    `Renamed the document from ${shown(ctx.before?.name ?? '')} to ${shown(c.name)}`,
  setConfigParameter: (c, ctx) => {
    const exists = ctx.before?.configurations?.parameters.some((p) => p.id === c.parameter.id);
    return `${exists ? 'Changed' : 'Added'} configuration parameter ${PARAMETER(c.parameter, ctx)}`;
  },
  deleteConfigParameter: (c, ctx) =>
    `Deleted configuration parameter ${ctx.names.configParameter(c.parameterId)}`,
  restoreConfigParameter: (c, ctx) =>
    `Restored configuration parameter ${PARAMETER(c.parameter, ctx)}`,
  setConfigRow: (c, ctx) => {
    const old = ctx.before?.configurations?.rows.find((r) => r.id === c.row.id);
    return old === undefined
      ? `Added configuration ${shown(c.row.name)} (${plural(Object.keys(c.row.values).length, 'value')})`
      : `Changed configuration ${shown(c.row.name)}: ${edited(old, c.row)}`;
  },
  deleteConfigRow: (c, ctx) => `Deleted configuration ${ctx.names.configRow(c.rowId)}`,
  restoreConfigRow: (c) => `Restored configuration ${shown(c.row.name)}`,
  setActiveConfiguration: (c, ctx) =>
    c.rowId === null
      ? 'Built the document as it is (no configuration active)'
      : `Made configuration ${ctx.names.configRow(c.rowId)} active`,
  addPart: (c) => `Added part ${shown(c.name)}${position(c.index)}`,
  renamePart: (c, ctx) => `Renamed part ${ctx.names.part(c.partId)} to ${shown(c.name)}`,
  deletePart: (c, ctx) => {
    const n = ctx.before?.parts.find((p) => p.id === c.partId)?.features.length;
    return `Deleted part ${ctx.names.part(c.partId)}${n === undefined ? '' : ` with ${plural(n, 'feature')}`}`;
  },
  restorePart: (c) =>
    `Restored part ${shown(c.part.name)} with ${plural(c.part.features.length, 'feature')}${position(c.index)}`,
  reorderParts: (c, ctx) => `Moved part ${ctx.names.part(c.partId)}${position(c.index)}`,
  duplicatePart: (c, ctx) =>
    `Duplicated part ${ctx.names.part(c.sourcePartId)} as ${shown(c.name)}`,
  addAssembly: (c) => `Added assembly ${shown(c.name)}`,
  renameAssembly: (c, ctx) =>
    `Renamed assembly ${ctx.names.assembly(c.assemblyId)} to ${shown(c.name)}`,
  deleteAssembly: (c, ctx) => `Deleted assembly ${ctx.names.assembly(c.assemblyId)}`,
  restoreAssembly: (c) =>
    `Restored assembly ${shown(c.assembly.name)} with ${plural(c.assembly.instances.length, 'instance')}`,
  addInstance: (c, ctx) => {
    const src = c.instance.source;
    const of =
      'part' in src
        ? ctx.names.part(src.part)
        : `${shown(src.documentName, 120)} (version ${shown(src.versionName, 120)})`;
    const t = c.instance.pose.translation.map((x) => valueText(x)).join(', ');
    return `Added instance ${shown(c.instance.name)} of ${of} to ${ctx.names.assembly(c.assemblyId)} at (${t})${c.instance.fixed ? ', fixed' : ''}`;
  },
  editInstance: (c, ctx) => {
    const fields = omit(c, ['type', 'assemblyId', 'instanceId']);
    const old = ctx.before?.assemblies
      .find((a) => a.id === c.assemblyId)
      ?.instances.find((i) => i.id === c.instanceId);
    const pick = old
      ? Object.fromEntries(Object.keys(fields).map((k) => [k, (old as Record<string, unknown>)[k]]))
      : {};
    return `Edited instance ${ctx.names.instance(c.assemblyId, c.instanceId)} in ${ctx.names.assembly(c.assemblyId)}: ${edited(pick, fields, [])}`;
  },
  setPoses: (c, ctx) => {
    const ids = Object.keys(c.poses);
    const named = ids.slice(0, 3).map((i) => ctx.names.instance(c.assemblyId, i));
    return `Moved ${plural(ids.length, 'instance')} in ${ctx.names.assembly(c.assemblyId)}: ${named.join(', ')}${ids.length > 3 ? ', ...' : ''}`;
  },
  deleteInstance: (c, ctx) =>
    `Deleted instance ${ctx.names.instance(c.assemblyId, c.instanceId)} from ${ctx.names.assembly(c.assemblyId)}`,
  restoreInstance: (c, ctx) =>
    `Restored instance ${shown(c.instance.name)} in ${ctx.names.assembly(c.assemblyId)}`,
  addMate: (c, ctx) =>
    `Added ${c.mate.kind} mate ${shown(c.mate.name)} to ${ctx.names.assembly(c.assemblyId)}${c.mate.suppressed ? ' (suppressed)' : ''}`,
  editMate: (c, ctx) => {
    const old = ctx.before?.assemblies
      .find((a) => a.id === c.assemblyId)
      ?.mates.find((m) => m.id === c.mate.id);
    return `Edited mate ${shown(c.mate.name)} in ${ctx.names.assembly(c.assemblyId)}: ${old ? edited(old, c.mate) : `${c.mate.kind} mate`}`;
  },
  deleteMate: (c, ctx) =>
    `Deleted mate ${ctx.names.mate(c.assemblyId, c.mateId)} from ${ctx.names.assembly(c.assemblyId)}`,
  restoreMate: (c, ctx) =>
    `Restored ${c.mate.kind} mate ${shown(c.mate.name)} in ${ctx.names.assembly(c.assemblyId)}`,
  suppressMate: (c, ctx) =>
    `${c.suppressed ? 'Suppressed' : 'Unsuppressed'} mate ${ctx.names.mate(c.assemblyId, c.mateId)} in ${ctx.names.assembly(c.assemblyId)}`,
  addPrintSetup: (c) =>
    `Added print setup ${shown(c.setup.name)} (${shown(c.setup.printer, 80)}, ${c.setup.nozzle} mm nozzle, ${plural(c.setup.items.length, 'item')})`,
  editPrintSetup: (c, ctx) => {
    const fields = omit(c, ['type', 'setupId']);
    const old = ctx.before?.print.setups.find((s) => s.id === c.setupId);
    const pick = old
      ? Object.fromEntries(Object.keys(fields).map((k) => [k, (old as Record<string, unknown>)[k]]))
      : {};
    return `Edited print setup ${ctx.names.printSetup(c.setupId)}: ${edited(pick, fields, [])}`;
  },
  deletePrintSetup: (c, ctx) => `Deleted print setup ${ctx.names.printSetup(c.setupId)}`,
  restorePrintSetup: (c) => `Restored print setup ${shown(c.setup.name)}`,
  addPrintItem: (c, ctx) =>
    `Added ${c.item.copies ?? 1} x ${ctx.names.part(c.item.part)}${c.item.body ? ` body ${shown(c.item.body, 120)}` : ''} to print setup ${ctx.names.printSetup(c.setupId)}`,
  editPrintItem: (c, ctx) => {
    const old = ctx.before?.print.setups
      .find((s) => s.id === c.setupId)
      ?.items.find((i) => i.id === c.item.id);
    return `Edited print item ${shown(c.item.id, 40)} of ${ctx.names.printSetup(c.setupId)}: ${old ? edited(old, c.item) : 'replaced'}`;
  },
  deletePrintItem: (c, ctx) =>
    `Deleted print item ${shown(c.itemId, 40)} from ${ctx.names.printSetup(c.setupId)}`,
  restorePrintItem: (c, ctx) =>
    `Restored ${ctx.names.part(c.item.part)} in print setup ${ctx.names.printSetup(c.setupId)}`,
  addFont: (c) =>
    `Added font ${shown(c.font.family, 120)} ${shown(c.font.style, 80)} (${c.font.source.kind === 'file' ? `file ${shown(c.font.source.fileName, 120)}` : 'bundled'})`,
  deleteFont: (c, ctx) => `Deleted font ${ctx.names.font(c.fontId)}`,
  restoreFont: (c) => `Restored font ${shown(c.font.family, 120)} ${shown(c.font.style, 80)}`,
  setScript: (c, ctx) => {
    const old = ctx.before?.scripts?.find((s) => s.id === c.script.id);
    const lines = plural(lineCount(c.script.source), 'line');
    return old === undefined
      ? `Added script ${shown(c.script.name)} (${c.script.language}, ${lines}; source in the bundle's scripts)`
      : `Changed script ${shown(c.script.name)} (${c.script.language}, ${lines}${old.source === c.script.source ? ', same source' : "; source in the bundle's scripts"})`;
  },
  deleteScript: (c, ctx) => `Deleted script ${ctx.names.script(c.scriptId)}`,
  restoreScript: (c) =>
    `Restored script ${shown(c.script.name)} (${c.script.language}; source in the bundle's scripts)`,
  setMechRequirements: (c, ctx) => {
    const before = mechItems(ctx.before?.mech, 'requirements');
    const ids = new Set(before.map((r) => r.id));
    const added = c.requirements.filter((r) => !ids.has(r.id)).length;
    const kept = new Set(c.requirements.map((r) => r.id));
    const removed = before.filter((r) => !kept.has(r.id)).length;
    return `Set the requirements: ${plural(c.requirements.length, 'requirement')} (${added} added, ${removed} removed)`;
  },
  restoreMechRequirements: (c) =>
    `Restored the requirements (${plural(c.requirements.length, 'requirement')})`,
  setElectrical: (c) =>
    `Set the electrical system: ${plural(c.electrical.components.length, 'component')}, ${plural(c.electrical.connections.length, 'connection')}, ${plural(c.electrical.harness.length, 'harness segment')}`,
  restoreElectrical: (c) =>
    `Restored the electrical system (${plural(c.electrical.components.length, 'component')})`,
  setMechLoadCase: (c, ctx) => mechSet('loadCases', 'load case', c.loadCase, ctx),
  deleteMechLoadCase: (c, ctx) => `Deleted load case ${mechNamed('loadCases', c.loadCaseId, ctx)}`,
  restoreMechLoadCase: (c) =>
    `Restored load case ${mechLabel(c.loadCase as { id: string } & Record<string, unknown>)}`,
  setDrivetrain: (c, ctx) => mechSet('drivetrains', 'drivetrain', c.drivetrain, ctx),
  deleteDrivetrain: (c, ctx) =>
    `Deleted drivetrain ${mechNamed('drivetrains', c.drivetrainId, ctx)}`,
  restoreDrivetrain: (c) =>
    `Restored drivetrain ${mechLabel(c.drivetrain as { id: string } & Record<string, unknown>)}`,
  setPurchasedUse: (c, ctx) => mechSet('purchased', 'purchased part', c.use, ctx),
  deletePurchasedUse: (c, ctx) => `Deleted purchased part ${mechNamed('purchased', c.useId, ctx)}`,
  restorePurchasedUse: (c) =>
    `Restored purchased part ${mechLabel(c.use as { id: string } & Record<string, unknown>)}`,
  setCatalogEntry: (c, ctx) => mechSet('catalog', 'catalog entry', c.entry, ctx),
  deleteCatalogEntry: (c, ctx) => `Deleted catalog entry ${mechNamed('catalog', c.entryId, ctx)}`,
  restoreCatalogEntry: (c) =>
    `Restored catalog entry ${mechLabel(c.entry as { id: string } & Record<string, unknown>)}`,
  setSchematic: (c, ctx) => mechSet('schematics', 'schematic', c.schematic, ctx),
  deleteSchematic: (c, ctx) => `Deleted schematic ${mechNamed('schematics', c.schematicId, ctx)}`,
  restoreSchematic: (c) =>
    `Restored schematic ${mechLabel(c.schematic as { id: string } & Record<string, unknown>)}`,
  setSymbol: (c, ctx) => mechSet('symbols', 'symbol', c.symbol, ctx),
  deleteSymbol: (c, ctx) => `Deleted symbol ${mechNamed('symbols', c.symbolId, ctx)}`,
  restoreSymbol: (c) =>
    `Restored symbol ${mechLabel(c.symbol as { id: string } & Record<string, unknown>)}`,
  setStudy: (c, ctx) => mechSet('studies', 'stress study', c.study, ctx),
  deleteStudy: (c, ctx) => `Deleted stress study ${mechNamed('studies', c.studyId, ctx)}`,
  restoreStudy: (c) =>
    `Restored stress study ${mechLabel(c.study as { id: string } & Record<string, unknown>)}`,
  setCheckOverride: (c, ctx) => mechSet('checks', 'check override', c.override, ctx),
  deleteCheckOverride: (c, ctx) =>
    `Deleted check override ${mechNamed('checks', c.overrideId, ctx)}`,
  restoreCheckOverride: (c) =>
    `Restored check override ${mechLabel(c.override as { id: string } & Record<string, unknown>)}`,
  setSpecNote: (c, ctx) => mechSet('specNotes', 'specification note', c.note, ctx),
  deleteSpecNote: (c, ctx) => `Deleted specification note ${mechNamed('specNotes', c.noteId, ctx)}`,
  restoreSpecNote: (c) =>
    `Restored specification note ${mechLabel(c.note as { id: string } & Record<string, unknown>)}`,
  setHazard: (c, ctx) => mechSet('hazards', 'hazard', c.hazard, ctx),
  deleteHazard: (c, ctx) => `Deleted hazard ${mechNamed('hazards', c.hazardId, ctx)}`,
  restoreHazard: (c) =>
    `Restored hazard ${mechLabel(c.hazard as { id: string } & Record<string, unknown>)}`,
  setTestBand: (c, ctx) => mechSet('testBands', 'test band', c.band, ctx),
  deleteTestBand: (c, ctx) => `Deleted test band ${mechNamed('testBands', c.bandId, ctx)}`,
  restoreTestBand: (c) =>
    `Restored test band ${mechLabel(c.band as { id: string } & Record<string, unknown>)}`,
  setMaterialDef: (c, ctx) => {
    const old = ctx.before?.materials?.find((m) => m.id === c.material.id);
    return old === undefined
      ? `Added material ${shown(c.material.name)} (${c.material.form}, density ${expressionText(c.material.density.value)})`
      : `Changed material ${shown(c.material.name)}: ${edited(old, c.material)}`;
  },
  deleteMaterialDef: (c, ctx) =>
    `Deleted material ${shown(ctx.before?.materials?.find((m) => m.id === c.materialId)?.name ?? c.materialId)}`,
  restoreMaterialDef: (c) => `Restored material ${shown(c.material.name)}`,
  setDomainData: (c, ctx) => {
    const before = ctx.before?.domains?.[c.namespace];
    const after =
      c.data === undefined ? undefined : { schemaVersion: c.schemaVersion!, data: c.data };
    const lines = domainLines(c.namespace, before, after, ctx.summarisers);
    const head = `${after === undefined ? 'Removed' : 'Set'} the ${shown(c.namespace, 64)} data`;
    return shown(
      lines.length > 0
        ? `${head}: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? '; ...' : ''}`
        : head,
    );
  },
  addExplodedView: (c, ctx) =>
    `Added exploded view ${shown(c.explodedView.name)} (${plural(c.explodedView.steps.length, 'step')}) to ${ctx.names.assembly(c.assemblyId)}`,
  editExplodedView: (c, ctx) =>
    `Edited exploded view ${shown(c.explodedView.name)} of ${ctx.names.assembly(c.assemblyId)}`,
  deleteExplodedView: (c, ctx) =>
    `Deleted exploded view ${ctx.names.explodedView(c.assemblyId, c.explodedViewId)} of ${ctx.names.assembly(c.assemblyId)}`,
  restoreExplodedView: (c, ctx) =>
    `Restored exploded view ${shown(c.explodedView.name)} of ${ctx.names.assembly(c.assemblyId)}`,
  addExplodeStep: (c, ctx) =>
    `Added a step moving ${plural(c.step.instances.length, 'instance')} ${expressionText(c.step.distance)} to exploded view ${ctx.names.explodedView(c.assemblyId, c.explodedViewId)}`,
  editExplodeStep: (c, ctx) =>
    `Edited step ${shown(c.step.id, 40)} of exploded view ${ctx.names.explodedView(c.assemblyId, c.explodedViewId)}`,
  deleteExplodeStep: (c, ctx) =>
    `Deleted step ${shown(c.stepId, 40)} of exploded view ${ctx.names.explodedView(c.assemblyId, c.explodedViewId)}`,
  restoreExplodeStep: (c, ctx) =>
    `Restored step ${shown(c.step.id, 40)} of exploded view ${ctx.names.explodedView(c.assemblyId, c.explodedViewId)}`,
  addDrawing: (c) =>
    `Added drawing ${shown(c.drawing.name)} (${plural(c.drawing.sheets.length, 'sheet')})`,
  renameDrawing: (c, ctx) =>
    `Renamed drawing ${ctx.names.drawing(c.drawingId)} to ${shown(c.name)}`,
  deleteDrawing: (c, ctx) => `Deleted drawing ${ctx.names.drawing(c.drawingId)}`,
  restoreDrawing: (c) => `Restored drawing ${shown(c.drawing.name)}`,
  reorderDrawings: (c, ctx) =>
    `Moved drawing ${ctx.names.drawing(c.drawingId)}${position(c.index)}`,
  addSheet: (c, ctx) =>
    `Added sheet ${shown(c.sheet.name)} (${
      typeof c.sheet.size === 'string'
        ? c.sheet.size
        : `${expressionText(c.sheet.size.width)} by ${expressionText(c.sheet.size.height)}`
    }, ${c.sheet.orientation}) to ${ctx.names.drawing(c.drawingId)}`,
  editSheet: (c, ctx) => {
    const fields = omit(c, ['type', 'drawingId', 'sheetId']);
    return `Edited sheet ${ctx.names.sheet(c.drawingId, c.sheetId)} of ${ctx.names.drawing(c.drawingId)}: ${Object.keys(fields).join(', ') || 'nothing'}`;
  },
  deleteSheet: (c, ctx) =>
    `Deleted sheet ${ctx.names.sheet(c.drawingId, c.sheetId)} of ${ctx.names.drawing(c.drawingId)}`,
  restoreSheet: (c, ctx) =>
    `Restored sheet ${shown(c.sheet.name)} of ${ctx.names.drawing(c.drawingId)}`,
  reorderSheets: (c, ctx) =>
    `Moved sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}${position(c.index)} in ${ctx.names.drawing(c.drawingId)}`,
  addView: (c, ctx) => {
    const src = c.view.source;
    const of = 'part' in src ? ctx.names.part(src.part) : ctx.names.assembly(src.assembly);
    const dir = typeof c.view.direction === 'string' ? c.view.direction : 'custom';
    return `Added ${an(dir)} view of ${of} to sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`;
  },
  editView: (c, ctx) =>
    `Edited view ${shown(c.view.label ?? c.view.id, 80)} on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  moveView: (c, ctx) =>
    `Moved view ${shown(c.viewId, 40)} on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  deleteView: (c, ctx) =>
    `Deleted view ${shown(c.viewId, 40)} from sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  restoreView: (c, ctx) =>
    `Restored view ${shown(c.view.label ?? c.view.id, 80)} on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  addDimension: (c, ctx) =>
    `Added ${an(c.dimension.kind)} dimension to sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  editDimension: (c, ctx) =>
    `Edited ${c.dimension.kind} dimension ${shown(c.dimension.id, 40)} on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  deleteDimension: (c, ctx) =>
    `Deleted dimension ${shown(c.dimensionId, 40)} from sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  restoreDimension: (c, ctx) =>
    `Restored ${c.dimension.kind} dimension on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  addNote: (c, ctx) =>
    `Added a note to sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}: ${valueText(c.note.text)}`,
  editNote: (c, ctx) =>
    `Edited a note on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}: ${valueText(c.note.text)}`,
  deleteNote: (c, ctx) =>
    `Deleted note ${shown(c.noteId, 40)} from sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}`,
  restoreNote: (c, ctx) =>
    `Restored a note on sheet ${ctx.names.sheet(c.drawingId, c.sheetId)}: ${valueText(c.note.text)}`,
  addCamTool: (c) =>
    `Added CAM tool ${shown(c.tool.name)} (${c.tool.kind}, ${expressionText(c.tool.diameter)} diameter)`,
  editCamTool: (c, ctx) => {
    const old = ctx.before?.cam.tools.find((t) => t.id === c.tool.id);
    return `Edited CAM tool ${shown(c.tool.name)}: ${old ? edited(old, c.tool) : 'replaced'}`;
  },
  deleteCamTool: (c, ctx) => `Deleted CAM tool ${ctx.names.camTool(c.toolId)}`,
  restoreCamTool: (c) => `Restored CAM tool ${shown(c.tool.name)}`,
  addCamSetup: (c, ctx) =>
    `Added CAM setup ${shown(c.setup.name)} for ${ctx.names.part(c.setup.part)} (${plural(c.setup.operations.length, 'operation')})`,
  editCamSetup: (c, ctx) => {
    const fields = omit(c, ['type', 'setupId']);
    const old = ctx.before?.cam.setups.find((s) => s.id === c.setupId);
    const pick = old
      ? Object.fromEntries(Object.keys(fields).map((k) => [k, (old as Record<string, unknown>)[k]]))
      : {};
    return `Edited CAM setup ${ctx.names.camSetup(c.setupId)}: ${edited(pick, fields, [])}`;
  },
  deleteCamSetup: (c, ctx) => `Deleted CAM setup ${ctx.names.camSetup(c.setupId)}`,
  restoreCamSetup: (c) => `Restored CAM setup ${shown(c.setup.name)}`,
  reorderCamSetups: (c, ctx) =>
    `Moved CAM setup ${ctx.names.camSetup(c.setupId)}${position(c.index)}`,
  addCamOperation: (c, ctx) =>
    `Added ${c.operation.kind} operation ${shown(c.operation.name)} with ${ctx.names.camTool(c.operation.tool)} to CAM setup ${ctx.names.camSetup(c.setupId)}`,
  editCamOperation: (c, ctx) => {
    const old = ctx.before?.cam.setups
      .find((s) => s.id === c.setupId)
      ?.operations.find((o) => o.id === c.operation.id);
    return `Edited ${c.operation.kind} operation ${shown(c.operation.name)} in ${ctx.names.camSetup(c.setupId)}: ${old ? edited(old, c.operation) : 'replaced'}`;
  },
  deleteCamOperation: (c, ctx) =>
    `Deleted operation ${ctx.names.camOperation(c.setupId, c.operationId)} from CAM setup ${ctx.names.camSetup(c.setupId)}`,
  restoreCamOperation: (c, ctx) =>
    `Restored ${c.operation.kind} operation ${shown(c.operation.name)} in ${ctx.names.camSetup(c.setupId)}`,
  reorderCamOperation: (c, ctx) =>
    `Moved operation ${ctx.names.camOperation(c.setupId, c.operationId)}${position(c.index)} in ${ctx.names.camSetup(c.setupId)}`,
  suppressCamOperation: (c, ctx) =>
    `${c.suppressed ? 'Suppressed' : 'Unsuppressed'} operation ${ctx.names.camOperation(c.setupId, c.operationId)} in ${ctx.names.camSetup(c.setupId)}`,
  replaceDocument: (c) =>
    `Replaced the whole document (a restore): ${plural(c.document.parts.length, 'part')}, ${plural(
      c.document.parts.reduce((n, p) => n + p.features.length, 0),
      'feature',
    )}, ${plural(c.document.assemblies.length, 'assembly', 'assemblies')}`,
  batch: (c) => `A batch of ${plural(c.commands.length, 'command')}`,
};

/** The summary line of `command`, bounded; one that fails says so rather than throwing. */
export function summarise(command: Command, ctx: SummaryContext): string {
  const fn = SUMMARIES[command.type] as Summariser<CommandType> | undefined;
  if (fn === undefined) return shown(`A ${String(command.type)} command`);
  try {
    return shown(fn(command as never, ctx));
  } catch {
    return shown(`A ${command.type} command`);
  }
}
