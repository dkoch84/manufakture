// The print workspace's state, derived from the document and the model (M3 plan, T3.1d): the active
// setup resolved, the bodies the viewport draws in their oriented placement, the overhang classes,
// the analysis worker's thickness and gaps, and the Issues list; and what it does to the viewport
// (build volume, shading, framing an issue) and to the selection (lay flat on a picked face).
// Everything is recomputed after a regen or an orientation change; nothing is stored.

import { DEFAULT_WARNING_BAND, applyPlacement } from '@manufakture/print';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { Exchanger } from '../io/exchange';
import type { PartModel } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import {
  geometryRef,
  isGeometryRef,
  type GeometryRef,
  type SelectionStore,
} from '../state/selection';
import { testHooksEnabled } from '../testHooks';
import type { BodyInput } from '../viewport/bodies';
import type { BuildVolume, ViewShading } from '../viewport/printView';
import type { ViewportApi } from '../viewport/Viewport';
import {
  IDLE_ANALYSIS,
  analysisRequest,
  thicknessValues,
  useThicknessAnalysis,
  type AnalysisState,
  type PrintAnalyzer,
} from './analysis';
import { layFlatCommand } from './commands';
import { overhangsOf, printIssues, type PrintIssue } from './issues';
import { createPrintMeshes } from './meshes';
import { parsePrintViewId, printViewBodies, resolveSetup, type ResolvedSetup } from './resolve';
import { activeSetup, type PrintUiStore } from './state';

export interface PrintWorkspaceOptions {
  open: boolean;
  documents: DocumentStoreApi;
  printUi: PrintUiStore;
  selection: SelectionStore;
  viewport: ViewportApi | null;
  /** Every regenerated part studio. */
  parts: readonly PartModel[];
  /** For the export-tolerance meshes; without one the viewport meshes are checked. */
  exchanger: Pick<Exchanger, 'tessellate'> | null;
  /** The print-analysis worker's client; without one walls and gaps are not checked. */
  analyzer: PrintAnalyzer | null;
}

export interface PrintWorkspace {
  resolved: ResolvedSetup | null;
  /** What the viewport draws while the workspace is open. */
  bodies: readonly BodyInput[];
  issues: readonly PrintIssue[];
  analysis: AnalysisState;
  /** Select and frame what an issue is about; null lets go. */
  onIssue: (issue: PrintIssue | null) => void;
}

/** Retry export-tolerance meshes a regen dropped after this long (ms). */
const MESH_RETRY_MS = 400;

/** The faces an issue names, as selectable references, and their placed box. */
export function issueSelection(
  issue: PrintIssue,
  bodies: readonly BodyInput[],
): {
  refs: GeometryRef[];
  box: { min: [number, number, number]; max: [number, number, number] } | null;
} {
  const refs: GeometryRef[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const target of issue.targets) {
    const body = bodies.find((b) => b.id === target.viewId);
    if (!body) continue;
    const { mesh, names, transform } = body;
    const faceCount = Math.floor(mesh.faceRanges.length / 2);
    const faces = target.faces.length > 0 ? target.faces : [];
    for (const f of faces) {
      const name = names[mesh.faceNames[f - 1] ?? -1];
      if (name !== undefined) {
        refs.push(geometryRef('face', body.id, name, { fragile: mesh.faceFragile[f - 1] === 1 }));
      }
    }
    const wanted = new Set(
      faces.length > 0 ? faces : Array.from({ length: faceCount }, (_, i) => i + 1),
    );
    const placement = transform
      ? { rotation: transform.rotation, translation: transform.translation }
      : { rotation: [0, 0, 0, 1] as const, translation: [0, 0, 0] as const };
    for (let t = 0; t < mesh.triangleFaces.length; t++) {
      if (!wanted.has(mesh.triangleFaces[t]!)) continue;
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t * 3 + k]!;
        const p = applyPlacement(placement, [
          mesh.positions[v * 3]!,
          mesh.positions[v * 3 + 1]!,
          mesh.positions[v * 3 + 2]!,
        ]);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, p[a]!);
          max[a] = Math.max(max[a]!, p[a]!);
        }
      }
    }
  }
  return { refs, box: min[0] <= max[0] ? { min, max } : null };
}

export function usePrintWorkspace({
  open,
  documents,
  printUi,
  selection,
  viewport,
  parts,
  exchanger,
  analyzer,
}: PrintWorkspaceOptions): PrintWorkspace {
  const doc = useStore(documents, (s) => s.document);
  const setupId = useStore(printUi, (s) => s.setupId);
  const shading = useStore(printUi, (s) => s.shading);
  const layingFlat = useStore(printUi, (s) => s.layingFlat);
  const setup = open ? activeSetup(doc, setupId) : undefined;

  // Export-tolerance meshes, asked for once per regenerated body.
  const meshes = useMemo(() => createPrintMeshes(exchanger), [exchanger]);
  const [meshRevision, setMeshRevision] = useState(0);
  const resolved = useMemo(() => {
    void meshRevision;
    return setup ? resolveSetup(doc, setup, parts, { meshOf: meshes.meshOf }) : null;
  }, [doc, setup, parts, meshes, meshRevision]);
  useEffect(() => {
    if (!resolved) return;
    const views = resolved.items.flatMap((i) => i.bodies.map((b) => b.view));
    if (views.length === 0) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void meshes.request(views).then((changed) => {
        if (!live) return;
        if (changed) setMeshRevision((n) => n + 1);
        else if (meshes.waiting(views)) timer = setTimeout(ask, MESH_RETRY_MS);
      });
    };
    ask();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [resolved, meshes]);

  const bodies = useMemo(() => (resolved ? printViewBodies(resolved) : []), [resolved]);
  const overhangs = useMemo(
    () => (resolved ? overhangsOf(resolved) : new Map<never, never>()),
    [resolved],
  );
  const request = useMemo(() => (open ? analysisRequest(resolved) : null), [open, resolved]);
  const analysis = useThicknessAnalysis(open ? analyzer : null, request);
  // Closing the workspace stops the analysis on its way: its reply would be dropped anyway.
  useEffect(() => {
    if (!open || !analyzer) return;
    return () => void analyzer.cancel();
  }, [open, analyzer]);
  const issues = useMemo(
    () => (resolved ? printIssues(resolved, overhangs, analysis.reply, doc.units) : []),
    [resolved, overhangs, analysis.reply, doc.units],
  );

  // The build volume and the shading, in the viewport.
  const printer = resolved?.printer ?? null;
  const volume = useMemo<BuildVolume | null>(
    () =>
      printer
        ? {
            area: printer.area,
            height: printer.height,
            excluded: printer.excluded.map((e) => e.polygon),
          }
        : null,
    [printer],
  );
  // Only while open: closing the workspace (or unmounting) takes the volume away again.
  useEffect(() => {
    if (!viewport || !open) return;
    viewport.setBuildVolume(volume);
    return () => viewport.setBuildVolume(null);
  }, [viewport, open, volume]);
  const values = useMemo(() => thicknessValues(resolved, analysis), [resolved, analysis]);
  const viewShading = useMemo<ViewShading | null>(() => {
    if (!open || !resolved) return null;
    if (shading === 'overhang') {
      return { kind: 'overhang', threshold: resolved.overhang, band: DEFAULT_WARNING_BAND };
    }
    if (shading === 'thickness') {
      return {
        kind: 'thickness',
        values,
        minFeature: resolved.thresholds.minFeature,
        minWall: resolved.thresholds.minWall,
      };
    }
    return null;
  }, [open, resolved, shading, values]);
  // After the bodies (the viewport sets them in its own effect, which runs first).
  useEffect(() => {
    if (!viewport || !open) return;
    viewport.setShading(viewShading);
    return () => viewport.setShading(null);
  }, [viewport, open, viewShading, bodies]);

  // Lay flat on a picked face: the next face selected on a drawn item.
  const bodiesRef = useRef(bodies);
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    bodiesRef.current = bodies;
    resolvedRef.current = resolved;
  }, [bodies, resolved]);
  useEffect(() => {
    if (!open || !layingFlat) return;
    return selection.subscribe((s) => {
      // Disarmed in the meantime (an issue clicked selects faces too): not a pick.
      if (!printUi.getState().layingFlat) return;
      const ref = s.selected.find((i) => isGeometryRef(i) && i.kind === 'face');
      if (!ref || !isGeometryRef(ref)) return;
      const ui = printUi.getState();
      const r = resolvedRef.current;
      const at = parsePrintViewId(ref.bodyId);
      const item = at && r?.items.find((i) => i.item.id === at.itemId);
      if (!r || !at || !item) {
        ui.setMessage('Pick a face of an item on the bed.');
        return;
      }
      const body = item.bodies.find((b) => b.sourceId === at.sourceId);
      const slot = body?.input.names.indexOf(ref.name) ?? -1;
      const index = body && slot >= 0 ? body.input.mesh.faceNames.indexOf(slot) + 1 : 0;
      const face = body?.input.topology?.faces.find((f) => f.index === index);
      if (ref.placeholder || !face?.normal) {
        ui.setMessage('That face is not flat: pick a planar face to lay the item on.');
        return;
      }
      const result = documents
        .getState()
        .execute(
          layFlatCommand(documents.getState().document, r.setup.id, item.item, ref.name),
          'Lay flat',
        );
      ui.setLayingFlat(false);
      ui.setItem(item.item.id);
      ui.setMessage(result.ok ? null : result.error.message);
      selection.getState().clear();
    });
  }, [open, layingFlat, selection, printUi, documents]);

  const onIssue = useCallback(
    (issue: PrintIssue | null) => {
      // Selecting an issue's faces is not the lay-flat pick: disarm first.
      if (printUi.getState().layingFlat) printUi.getState().setLayingFlat(false);
      printUi.getState().setFocus(issue?.key ?? null);
      if (!issue) {
        selection.getState().clear();
        return;
      }
      const { refs, box } = issueSelection(issue, bodiesRef.current);
      if (refs.length > 0) selection.getState().select(refs);
      else selection.getState().clear();
      if (box && viewport) viewport.frameBox(box);
    },
    [printUi, selection, viewport],
  );

  // Test hook (see testHooks.ts).
  const issuesRef = useRef(issues);
  const meshesRef = useRef(meshes);
  const analysisRef = useRef(analysis);
  useEffect(() => {
    issuesRef.current = issues;
    analysisRef.current = analysis;
    meshesRef.current = meshes;
  }, [issues, analysis, meshes]);
  useEffect(() => {
    if (!testHooksEnabled || !viewport) return;
    window.__manufakture = {
      ...window.__manufakture,
      print: {
        ui: printUi,
        resolved: () => resolvedRef.current,
        bodies: () => bodiesRef.current,
        issues: () => issuesRef.current,
        analysis: () => analysisRef.current,
        // True once every drawn body has its export-tolerance mesh (or never will get one).
        meshesSettled: () => {
          const r = resolvedRef.current;
          return (
            !r || !meshesRef.current.waiting(r.items.flatMap((i) => i.bodies.map((b) => b.view)))
          );
        },
      },
    };
    return () => {
      const hooks = window.__manufakture;
      if (!hooks) return;
      delete hooks.print;
      if (Object.keys(hooks).length === 0) delete window.__manufakture;
    };
  }, [viewport, printUi]);

  return {
    resolved,
    bodies,
    issues,
    analysis: open ? analysis : IDLE_ANALYSIS,
    onIssue,
  };
}
