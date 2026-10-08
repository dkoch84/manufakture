// A document's named versions, newest first, each with one action (View in the History panel).
// Kept apart from the panel so that choosing a version elsewhere (the version a derived part
// pins, T2.2c) shows versions the same way. A version kept from the sync server (T7.1e) names no
// revision of this browser and says where it came from instead.

import type { Version } from '@manufakture/library';
import { formatWhen } from './history';

export interface VersionListProps {
  /** Oldest first, as the library lists them; shown newest first. */
  versions: readonly Version[];
  /** The action on each version. */
  onPick: (version: Version) => void;
  /** The action's button text (default "View"). */
  pickLabel?: string;
  /** The version shown or chosen now, marked and not offered again. */
  currentId?: string | null;
  disabled?: boolean;
  /** A tag shown beside a version's name (the branch it was made on), or null for none. */
  tagOf?: ((version: Version) => string | null) | undefined;
}

export function VersionList({
  versions,
  onPick,
  pickLabel = 'View',
  currentId = null,
  disabled = false,
  tagOf,
}: VersionListProps) {
  if (versions.length === 0) {
    return (
      <p className="field-note" data-testid="versions-empty">
        No versions yet. A version names the document as it is now, so you can come back to it.
      </p>
    );
  }
  return (
    <ul className="history-list" data-testid="version-list">
      {[...versions].reverse().map((v) => {
        const tag = tagOf?.(v) ?? null;
        return (
          <li
            key={v.id}
            className={v.id === currentId ? 'history-item history-current' : 'history-item'}
            data-testid={`version-${v.name}`}
          >
            <div className="history-item-head">
              <span className="history-name">{v.name}</span>
              {tag && (
                <span className="history-tag" data-testid={`version-branch-${v.name}`}>
                  {tag}
                </span>
              )}
              <button
                type="button"
                disabled={disabled || v.id === currentId}
                onClick={() => onPick(v)}
                aria-label={`${pickLabel} version ${v.name}`}
              >
                {pickLabel}
              </button>
            </div>
            <div className="history-meta">
              {formatWhen(v.createdAt)},{' '}
              {v.serverRev === undefined ? (
                `revision ${v.revision}`
              ) : (
                <span
                  data-testid={`version-from-server-${v.name}`}
                  title="Made in another browser: kept from the sync server"
                >
                  from the server
                </span>
              )}
            </div>
            {v.description && <div className="history-description">{v.description}</div>}
          </li>
        );
      })}
    </ul>
  );
}
