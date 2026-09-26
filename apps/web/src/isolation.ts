type IsolationScope = { crossOriginIsolated?: boolean };
type Logger = Pick<Console, 'info' | 'warn'>;

/** True when the page is cross-origin isolated (needed for SharedArrayBuffer). */
export function isCrossOriginIsolated(scope: IsolationScope = globalThis): boolean {
  return scope.crossOriginIsolated === true;
}

/** Logs whether the page is cross-origin isolated and returns the result. */
export function logCrossOriginIsolation(
  scope: IsolationScope = globalThis,
  logger: Logger = console,
): boolean {
  const isolated = isCrossOriginIsolated(scope);
  if (isolated) {
    logger.info('crossOriginIsolated: true');
  } else {
    logger.warn(
      'crossOriginIsolated: false. SharedArrayBuffer is unavailable; check that the server sends COOP/COEP headers.',
    );
  }
  return isolated;
}
