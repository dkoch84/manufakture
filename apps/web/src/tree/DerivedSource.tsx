// What the feature tree shows under a derived part: where it comes from ("From Bracket at 6 mm"),
// **Update available** when its source has versions named after the pinned one, **Update**
// (choose a version: the pin moves to it as one undo step, an `editFeature`), and **Open source**
// (the source document, read-only at the pinned version, in the version viewer).
//
// The source documents' version lists are read once per tree (and again after an update or when
// the derived parts change), one short library call per source document.

import type { Command, DerivedFeature, DerivedSource } from '@manufakture/core';
import { useMemo, useState } from 'react';
import type { Version } from '@manufakture/library';
import { VersionList } from '../history/VersionList';
import '../history/history.css';
import { newerVersions, pinLabel, readUpdate, type PinLibrary } from '../features/derived';

export interface DerivedSourceLineProps {
  feature: DerivedFeature;
  partId: string;
  /** The source document's versions; null when it cannot be listed, undefined while reading. */
  versions: Version[] | null | undefined;
  library: PinLibrary | null;
  disabled: boolean;
  /** Run a command (one undo step); false when the document refused it. */
  run: (command: Command, label: string) => boolean;
  onMessage: (message: string | null) => void;
  /** After an update: read the version lists again. */
  onUpdated: () => void;
  onOpenSource?: ((source: DerivedSource) => void) | undefined;
}

export function DerivedSourceLine({
  feature,
  partId,
  versions,
  library,
  disabled,
  run,
  onMessage,
  onUpdated,
  onOpenSource,
}: DerivedSourceLineProps) {
  const { source } = feature;
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const newer = useMemo(
    () => (versions ? newerVersions(versions, source.versionId) : null),
    [versions, source.versionId],
  );
  const known = versions !== undefined && versions !== null && newer !== null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  const choose = (version: Version) => {
    if (!library) return;
    setBusy(true);
    void readUpdate(library, partId, feature, version)
      .then((r) => {
        if (!r.ok) {
          onMessage(`${feature.name} cannot be updated to "${version.name}": ${r.message}`);
          return;
        }
        if (run(r.value.command, r.value.label)) {
          setChoosing(false);
          onUpdated();
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="derived-source"
      data-testid={`derived-source-${feature.id}`}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
    >
      <span className="derived-from" title={`Pinned to ${pinLabel(source)}`}>
        From {pinLabel(source)}
      </span>
      {known && newer.length > 0 && (
        <span
          className="derived-update-available"
          data-testid={`update-available-${feature.id}`}
          title={`Newer: ${newer.map((v) => v.name).join(', ')}`}
        >
          Update available
        </span>
      )}
      {versions === null && (
        <span className="derived-missing" title="The source document is not in this browser">
          Source not here
        </span>
      )}
      <span className="derived-actions">
        {known && library && (
          <button
            type="button"
            disabled={disabled || busy}
            aria-expanded={choosing}
            aria-label={`Update ${feature.name}`}
            data-testid={`update-${feature.id}`}
            onClick={() => setChoosing((c) => !c)}
          >
            Update
          </button>
        )}
        {versions && onOpenSource && newer !== null && (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Open the source of ${feature.name}`}
            data-testid={`open-source-${feature.id}`}
            onClick={() => onOpenSource(source)}
          >
            Open source
          </button>
        )}
      </span>
      {choosing && versions && (
        <div
          className="derived-versions"
          role="group"
          aria-label={`Versions of ${source.documentName || 'the source'}`}
          data-testid={`update-versions-${feature.id}`}
        >
          <VersionList
            versions={versions}
            pickLabel="Use"
            currentId={source.versionId}
            disabled={disabled || busy}
            onPick={choose}
          />
          <button type="button" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
