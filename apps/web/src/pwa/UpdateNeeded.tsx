// "Update the app" (T7.4b): shown where this version meets something saved or sent by a newer one.
// A document saved by a newer version is refused, as ADR 0004 decision 2 says (never opened, never
// changed); this note says why and offers to fetch the new version, then Reload. The sync protocol
// handshake (T7.1d) shows it with `reason="sync-protocol"`.
//
// "Update the app" asks the host for a new version (appUpdate.ts). When one installs, the update
// flow flushes autosave and Reload appears here (and in the corner note, PwaStatus); with no
// service worker, Reload simply loads the page again from the host.

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { appUpdater, type AppUpdater, type UpdateNeededReason } from './appUpdate';
import type { UpdateCheck } from './register';
import type { UpdateState } from './updateFlow';
import './pwa.css';

const WHY: Record<UpdateNeededReason, string> = {
  document:
    'This document needs a newer version of manufakture than the one running here. Update the app, then open it again.',
  'sync-protocol':
    'The sync server needs a newer version of manufakture than the one running here. Update the app to keep syncing; your documents stay in this browser meanwhile.',
};

const FOUND: Record<Exclude<UpdateCheck, 'ready' | 'no-worker'>, string> = {
  none: 'There is no newer version on this site yet. Open the document in the version of manufakture that saved it, or try again later.',
  offline:
    'manufakture cannot reach its site, so it cannot update now. Connect to the internet, then try again.',
};

/** A flow state for when there is no flow (no service worker). */
const IDLE = createStore<UpdateState>()(() => ({ kind: 'idle' }));

type Step = 'start' | 'checking' | UpdateCheck;

export function UpdateNeeded({
  reason,
  updater = appUpdater(),
}: {
  reason: UpdateNeededReason;
  updater?: AppUpdater | undefined;
}) {
  const [step, setStep] = useState<Step>('start');
  const flowState = useStore(updater.flow?.state ?? IDLE);

  const check = async () => {
    setStep('checking');
    try {
      setStep(await updater.check());
    } catch {
      setStep('offline');
    }
  };

  let detail: ReactNode;
  if (step === 'start' || step === 'none' || step === 'offline') {
    detail = (
      <>
        {step !== 'start' && <span data-testid="update-needed-result">{FOUND[step]}</span>}
        <button type="button" className="pwa-primary" onClick={() => void check()}>
          {step === 'start' ? 'Update the app' : 'Try again'}
        </button>
      </>
    );
  } else if (step === 'checking') {
    detail = <span aria-busy="true">Looking for a new version...</span>;
  } else if (step === 'no-worker') {
    detail = (
      <>
        <span data-testid="update-needed-result">Reload to load the newest version.</span>
        <button type="button" className="pwa-primary" onClick={updater.reloadPage}>
          Reload
        </button>
      </>
    );
  } else if (flowState.kind === 'ready' || flowState.kind === 'reloading') {
    detail = (
      <>
        <span data-testid="update-needed-result">
          A new version is ready. Your changes are saved.
        </span>
        <button
          type="button"
          className="pwa-primary"
          disabled={flowState.kind === 'reloading'}
          onClick={() => void updater.flow?.reload()}
        >
          Reload
        </button>
      </>
    );
  } else if (flowState.kind === 'blocked') {
    detail = <span data-testid="update-needed-result">{flowState.message}</span>;
  } else if (flowState.kind === 'saving') {
    detail = (
      <span data-testid="update-needed-result" aria-busy="true">
        A new version is downloaded; saving your changes first...
      </span>
    );
  } else {
    // Put off with Later in the corner note (or not offered yet): it can be asked for again.
    detail = (
      <>
        <span data-testid="update-needed-result">
          A new version is downloaded and waits until you reload.
        </span>
        <button type="button" className="pwa-primary" onClick={() => void check()}>
          Update the app
        </button>
      </>
    );
  }

  return (
    // A span (styled as a block), so it can sit in the home screen's status paragraph.
    <span className="pwa-update-needed" data-testid="update-needed">
      <span>{WHY[reason]}</span> {detail}
    </span>
  );
}
