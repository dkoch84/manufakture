import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSelectionStore } from '../state/selection';
import { createViewSettingsStore } from '../state/viewSettings';
import { boxBody } from './testMeshes';
import { Viewport, type ViewportApi } from './Viewport';

// As in a production build without VITE_E2E: no test hook on window.
vi.mock('../testHooks', () => ({ testHooksEnabled: false }));

describe('Viewport in a production build', () => {
  it('does not expose the test hook', () => {
    const api = { setBodies: vi.fn(), dispose: vi.fn() } as unknown as ViewportApi;
    const view = render(
      <Viewport
        bodies={[boxBody()]}
        createEngine={() => api}
        selection={createSelectionStore()}
        settings={createViewSettingsStore()}
      />,
    );
    expect(api.setBodies).toHaveBeenCalled();
    expect(window.__manufakture).toBeUndefined();
    view.unmount();
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });
});
