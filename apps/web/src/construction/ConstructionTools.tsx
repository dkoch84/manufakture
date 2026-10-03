// The construction tool that has the side panel (the Wall, Opening, Floor or Roof tool), with the
// document's construction settings read for it. Loaded on demand with the Construction panel, so
// the construction domain stays out of the app's start-up chunk.

import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import type { ViewportApi } from '../viewport/Viewport';
import { FloorTool } from './floor/FloorTool';
import { OpeningTool } from './OpeningTool';
import { RoofTool } from './roof/RoofTool';
import { documentConstruction } from './settings';
import type { ConstructionUiStore } from './state';
import { WallTool } from './WallTool';
import './construction.css';

export function ConstructionTools({
  documents,
  model,
  selection,
  ui,
  partId,
  viewport,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  ui: ConstructionUiStore;
  partId: string;
  viewport: ViewportApi | null;
}) {
  const doc = useStore(documents, (s) => s.document);
  const tool = useStore(ui, (s) => s.tool);
  const data = useMemo(() => documentConstruction(doc), [doc]);
  const settings = data.ok ? data.data?.settings : undefined;
  const close = () => ui.getState().endTool();
  if (tool === null) return null;
  if (tool.kind === 'wall') {
    return (
      <WallTool
        key={partId}
        documents={documents}
        model={model}
        ui={ui}
        partId={partId}
        settings={settings}
        viewport={viewport}
        onClose={close}
      />
    );
  }
  if (tool.kind === 'floor') {
    return (
      <FloorTool
        key={`${partId}/${tool.featureId ?? 'new'}`}
        documents={documents}
        ui={ui}
        partId={partId}
        settings={settings}
        featureId={tool.featureId}
        onClose={close}
      />
    );
  }
  if (tool.kind === 'roof') {
    return (
      <RoofTool
        key={`${partId}/${tool.featureId ?? 'new'}`}
        documents={documents}
        model={model}
        ui={ui}
        partId={partId}
        settings={settings}
        featureId={tool.featureId}
        viewport={viewport}
        onClose={close}
      />
    );
  }
  return (
    <OpeningTool
      key={`${partId}/${tool.featureId ?? 'new'}`}
      documents={documents}
      model={model}
      selection={selection}
      partId={partId}
      settings={settings}
      featureId={tool.featureId}
      wall={tool.wall}
      onClose={close}
    />
  );
}
