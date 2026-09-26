import type { LoadStatus } from './scenes';

export function LoadingSplash({ status, error }: { status: LoadStatus; error?: string | null }) {
  const percent = status.fraction === null ? undefined : Math.round(status.fraction * 100);
  return (
    <div className="splash" data-testid="splash">
      <h1>manufakture</h1>
      {error ? (
        <p role="alert">Could not load the model: {error}</p>
      ) : (
        <>
          <p>{status.label}</p>
          <div
            className="splash-bar"
            role="progressbar"
            aria-label={status.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={percent === undefined ? 'splash-fill indeterminate' : 'splash-fill'}
              style={{ width: percent === undefined ? '30%' : `${percent}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
