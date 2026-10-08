// The banner over a document whose scripts the user has not allowed on this device (policy.ts):
// it lists the scripted features and the scripts they run, and the derived parts whose source
// document's scripts did not run (regen reports those; they run only when the whole document is
// allowed), says that none of them ran, and offers **Run scripts** for this document. Until then
// each of those features shows "Scripts not run". On an agent's branch (the store's
// `agentDocument`) the banner lists every feature whose script has not run, never "and N more",
// and **Run scripts** allows exactly the scripts listed, as the branch has them, never the whole
// document, so a script the agent changes later is asked about again (T8.3b). Derived parts'
// sources stay blocked there: they would need their whole document allowed, which `policy()`
// never sends for an agent's branch.

import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { ManufaktureDocument } from '@manufakture/core';
import { useModel, type ModelStore } from '../model/model';
import { blockedSources, blockedUses, type ScriptGrantsStore } from './policy';
import { useSourceHashes } from './useSourceHashes';
import './scripts.css';

/** How many features the banner names before it says "and N more" (not on an agent's branch). */
const LISTED = 8;

export function ScriptsBanner({
  document,
  grants,
  model,
  disabled = false,
}: {
  document: ManufaktureDocument;
  grants: ScriptGrantsStore;
  /** The regenerated model: what tells of derived parts whose source scripts did not run. */
  model: ModelStore;
  disabled?: boolean;
}) {
  // Subscribed for re-rendering; the state's functions read the store itself.
  const state = useStore(grants);
  const texts = useMemo(() => (document.scripts ?? []).map((s) => s.source), [document.scripts]);
  const shas = useSourceHashes(texts);
  const built = useModel(model, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const own = blockedUses(document, state, shas);
  const sources = blockedSources(document, state, built, parts);
  if (own === null && sources.length === 0) return null;
  const blocked = own ?? [];
  if (blocked.length === 0 && sources.length === 0) return null;
  const agent = state.agentDocument === document.id;
  // On an agent's branch every script Run scripts would allow is listed.
  const shown = agent ? blocked : blocked.slice(0, LISTED);
  const shownSources = sources.slice(0, Math.max(LISTED - shown.length, 1));
  const hidden = blocked.length - shown.length + sources.length - shownSources.length;
  const count = new Set(blocked.map((u) => u.script!.name)).size + sources.length;
  return (
    <div
      className="scripts-banner"
      role="region"
      aria-label="Scripts not run"
      data-testid="scripts-banner"
    >
      {agent ? (
        <p data-testid="scripts-banner-agent">
          <strong>This agent&apos;s branch has scripts that have not run.</strong> Scripts are code,
          and an agent may have written or changed them: read them in the review first. Run scripts
          allows each one exactly as it is now, on this device; a script changed later is asked
          about again. The scripts of derived parts&apos; sources do not run on an agent&apos;s
          branch, whatever was allowed for those documents.
        </p>
      ) : (
        <p>
          <strong>This document has scripts that have not run.</strong> Scripts are code written by
          whoever made the document. They run only after you allow them for this document on this
          device.
        </p>
      )}
      <ul data-testid="scripts-banner-features">
        {shown.map((u) => (
          <li key={`${u.partId}/${u.feature.id}`}>
            {document.parts.length > 1 ? `${u.partName} / ` : ''}
            {u.feature.name}: script <em>{u.script!.name}</em>
          </li>
        ))}
        {shownSources.map((x) => (
          <li key={`${x.partId}/${x.featureId}`}>
            {document.parts.length > 1 ? `${x.partName} / ` : ''}
            {x.featureName}: the scripts of its source document <em>{x.documentName}</em>
          </li>
        ))}
        {hidden > 0 && <li>and {hidden} more</li>}
      </ul>
      <button
        type="button"
        className="primary"
        data-testid="run-scripts"
        disabled={disabled || (agent && blocked.length === 0)}
        title={
          agent
            ? 'Run the scripts listed, exactly as this branch has them, on this device'
            : `Run ${count === 1 ? 'the scripts' : 'all the scripts'} of this document and of its derived parts' sources, now and whenever it opens on this device`
        }
        onClick={() => {
          if (!agent) {
            grants.getState().allowDocument(document.id);
            return;
          }
          // Exactly the scripts listed (`shown` is all of `blocked` here).
          const scripts = new Map(shown.map((u) => [u.script!.id, u.script!]));
          for (const script of scripts.values()) {
            void grants.getState().allowSource(document.id, script.id, script.source);
          }
        }}
      >
        Run scripts
      </button>
    </div>
  );
}
