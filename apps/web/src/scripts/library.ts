// The script library's logic, free of React: what the editor starts from, how a draft becomes the
// script `setScript` stores, and which features run a script.

import {
  MAX_SCRIPT_NAME,
  previewIds,
  scriptUsers,
  type ManufaktureDocument,
  type Script,
} from '@manufakture/core';
import { NEW_SCRIPT_SOURCE, SCRIPT_API_VERSION, newScriptName } from './template';

export interface Draft {
  name: string;
  language: 'js' | 'ts';
  source: string;
}

export function draftOf(doc: ManufaktureDocument, scriptId: string | null): Draft {
  const script = scriptId === null ? undefined : doc.scripts?.find((s) => s.id === scriptId);
  if (script) return { name: script.name, language: script.language, source: script.source };
  return {
    name: newScriptName((doc.scripts ?? []).map((s) => s.name)),
    language: 'js',
    source: NEW_SCRIPT_SOURCE,
  };
}

/**
 * The script a draft saves as: the stored script with its new name, language and source (its id
 * and API version kept), or a new one with the next id and the current API version.
 */
export function scriptFromDraft(
  doc: ManufaktureDocument,
  scriptId: string | null,
  draft: Draft,
): { ok: true; script: Script } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, error: 'A script needs a name.' };
  if (name.length > MAX_SCRIPT_NAME) {
    return { ok: false, error: `A name has at most ${MAX_SCRIPT_NAME} characters.` };
  }
  const existing = scriptId === null ? undefined : doc.scripts?.find((s) => s.id === scriptId);
  return {
    ok: true,
    script: {
      id: existing?.id ?? previewIds(doc.nextIds, 'script')[0]!,
      name,
      language: draft.language,
      apiVersion: existing?.apiVersion ?? SCRIPT_API_VERSION,
      source: draft.source,
    },
  };
}

/** "Run by Scripted 1, Scripted 2", or "Not used". */
export function usersText(doc: ManufaktureDocument, scriptId: string): string {
  const users = scriptUsers(doc, scriptId).map((path) => {
    const [partId, featureId] = path.split('/');
    const part = doc.parts.find((p) => p.id === partId);
    const name = part?.features.find((f) => f.id === featureId)?.name ?? featureId!;
    return doc.parts.length > 1 ? `${part?.name ?? partId} / ${name}` : name;
  });
  if (users.length === 0) return 'Not used';
  if (users.length <= 3) return `Run by ${users.join(', ')}`;
  return `Run by ${users.slice(0, 2).join(', ')} and ${users.length - 2} more`;
}
