// The script API version (ADR 0010 decision 9): every script is stamped with the version it was
// written against (stored with the script in the document, T7.2a) and may also declare it with
// `export const apiVersion = 1`. A version is a promise: a script written against it runs
// unchanged, with the same results, in every later build. Additions are made within a version
// only when they cannot change what an existing script sees; anything else is a new version, and
// the old one stays. A build refuses versions it does not know, with a message saying so.
//
// The version covers this package's side (the globals, the shims, the value rules, the shape of a
// script) and the `ctx` API the regen worker hands to `run` (T7.2c), which picks its functions by
// the same number.

import { scriptError, type ScriptError } from './errors';

/** The version new scripts are stamped with. */
export const CURRENT_SCRIPT_API_VERSION = 1;

/** Every version this build runs. Never remove one. */
export const SCRIPT_API_VERSIONS: readonly number[] = Object.freeze([1]);

export function isSupportedApiVersion(version: unknown): version is number {
  return typeof version === 'number' && SCRIPT_API_VERSIONS.includes(version);
}

/** Null when `version` runs here, else the error to report. */
export function checkApiVersion(version: unknown): ScriptError | null {
  if (isSupportedApiVersion(version)) return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return scriptError('api-version', `Script API version ${String(version)} is not valid.`);
  }
  const known = SCRIPT_API_VERSIONS.join(', ');
  return scriptError(
    'api-version',
    version > CURRENT_SCRIPT_API_VERSION
      ? `This script needs script API version ${version}; this version of manufakture runs versions ${known}. Update manufakture to run it.`
      : `Script API version ${version} is not supported (supported: ${known}).`,
  );
}
