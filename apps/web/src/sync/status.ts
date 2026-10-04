// The sync status in words, for the Sync button and its panel.

import type { SyncStatus } from './controller';

/** The status in a few words, for the button and the panel. */
export function statusText(status: SyncStatus): string {
  switch (status.kind) {
    case 'off':
      return 'Not synced';
    case 'starting':
      return 'Starting sync...';
    case 'connecting':
      return status.pending > 0 ? `Connecting (${status.pending} pending)` : 'Connecting...';
    case 'synced':
      return 'Synced';
    case 'pending':
      return `Pending ${status.pending}`;
    case 'offline':
      return status.pending > 0 ? `Offline (${status.pending} pending)` : 'Offline';
    case 'other-tab':
      return 'Synced by another tab';
    case 'branch':
      return 'Only the main branch syncs';
    case 'no-server':
      return 'No server';
    case 'update-app':
      return 'Update the app to sync';
    case 'upgrade-server':
      return 'The server is too old';
    case 'fault':
      return 'Sync stopped';
    case 'error':
      return 'Not saved: not sent';
    case 'problem':
      return 'Cannot sync';
  }
}

/** The longer explanation, when there is one. */
export function statusDetail(status: SyncStatus): string | null {
  switch (status.kind) {
    case 'offline':
      return 'Changes are kept in this browser and sent when it is back online.';
    case 'other-tab':
      return 'Another tab of this browser has this document open and syncs it. Edit it there, or close that tab.';
    case 'branch':
      return 'A branch is open. Open the main branch to sync it.';
    case 'no-server':
    case 'upgrade-server':
    case 'fault':
    case 'error':
    case 'problem':
      return status.message;
    default:
      return null;
  }
}
