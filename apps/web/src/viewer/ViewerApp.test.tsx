import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyInput } from '../viewport/bodies';
import type { PointerDelegate } from '../viewport/engine';
import type { EngineFactory, ViewportApi } from '../viewport/Viewport';
import { boxBundle } from './bundles.test-fixture';
import type { offerSource } from './handoff';
import { ViewerApp } from './ViewerApp';

interface FakeEngine {
  setBodies: ReturnType<typeof vi.fn<(inputs: readonly BodyInput[], fit?: boolean) => void>>;
  setPointerDelegate: ReturnType<typeof vi.fn<(d: PointerDelegate | null) => void>>;
  addOverlay: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function fakeEngine(): { factory: EngineFactory; engine: FakeEngine } {
  const engine = {
    setBodies: vi.fn(),
    setPointerDelegate: vi.fn(),
    addOverlay: vi.fn(() => () => {}),
    dispose: vi.fn(),
    surfacePoint: vi.fn(() => null),
    onViewChange: vi.fn(() => () => {}),
    projectToCanvas: vi.fn(() => ({ x: 0, y: 0 })),
    setStandardView: vi.fn(),
    fitAll: vi.fn(),
  };
  return { factory: () => engine as unknown as ViewportApi, engine: engine as FakeEngine };
}

const text = (el: Element | undefined) => el?.textContent ?? '';

const VIEWER = {
  hash: '',
  hostname: 'viewer.example',
  href: 'https://viewer.example/viewer.html',
};

function pick(file: File) {
  fireEvent.change(screen.getByTestId('viewer-file'), { target: { files: [file] } });
}

const fileOf = (bytes: Uint8Array, name = 'bracket.mfkview') =>
  new File([bytes as Uint8Array<ArrayBuffer>], name);

describe('ViewerApp', () => {
  it('opens a picked file: name, bodies, size, and the viewport gets every body', async () => {
    const { factory, engine } = fakeEngine();
    render(<ViewerApp createEngine={factory} location={VIEWER} />);
    pick(fileOf(await boxBundle()));
    expect(text(await screen.findByTestId('viewer-name'))).toMatch('Bracket');
    const rows = within(screen.getByTestId('viewer-bodies')).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.viewer-body-name')!.textContent)).toEqual([
      'Base',
      'Block',
    ]);
    expect(text(rows[0])).toMatch('PLA');
    expect(text(screen.getByTestId('viewer-size'))).toMatch(/^X 60.*, Y 30.*, Z 20/);
    const last = engine.setBodies.mock.calls.at(-1)!;
    expect(last[0].map((b) => b.id)).toEqual(['0/0', '0/1']);
    expect(last[1]).toBe(true);
    // No source in this bundle: nothing to open in the app.
    expect(screen.queryByTestId('viewer-open-app')).toBeNull();
  });

  it('renders hostile names as plain text, without bidi overrides', async () => {
    const { factory } = fakeEngine();
    const { container } = render(<ViewerApp createEngine={factory} location={VIEWER} />);
    const bytes = await boxBundle({
      name: '<img src=x onerror=alert(1)>',
      bodyNames: ['\u202egpj.exe', '<script>alert(1)</script>'],
    });
    pick(fileOf(bytes));
    expect(text(await screen.findByTestId('viewer-name'))).toMatch('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img, script')).toBeNull();
    const names = [...container.querySelectorAll('.viewer-body-name')].map((n) => n.textContent);
    expect(names).toEqual(['gpj.exe', '<script>alert(1)</script>']);
  });

  it('hides and shows bodies without reframing', async () => {
    const { factory, engine } = fakeEngine();
    render(<ViewerApp createEngine={factory} location={VIEWER} />);
    pick(fileOf(await boxBundle()));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show Block' }));
    const last = engine.setBodies.mock.calls.at(-1)!;
    expect(last[0].map((b) => b.id)).toEqual(['0/0']);
    expect(last[1]).toBe(false);
    expect(text(screen.getByTestId('viewer-size'))).toMatch(/^X 40/);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(engine.setBodies.mock.calls.at(-1)![0]).toHaveLength(2);
  });

  it('shows an error for a damaged file and for one over the size limit', async () => {
    const { factory } = fakeEngine();
    render(<ViewerApp createEngine={factory} location={VIEWER} />);
    pick(fileOf(new Uint8Array([80, 75, 3, 4, 0, 0])));
    expect(text(await screen.findByTestId('viewer-error'))).toMatch(/not|damaged/i);
    const big = fileOf(new Uint8Array(1));
    Object.defineProperty(big, 'size', { value: 65 * 1024 * 1024 });
    pick(big);
    await waitFor(() =>
      expect(text(screen.getByTestId('viewer-error'))).toMatch(/larger than 64 MB/),
    );
  });

  it('downloads the bundle a link names, with no credentials', async () => {
    const { factory } = fakeEngine();
    const bytes = await boxBundle();
    const fetch = vi.fn(
      async () => new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 }),
    );
    const location = { ...VIEWER, hash: '#src=https://files.example/b.mfkview' };
    render(
      <ViewerApp
        createEngine={factory}
        location={location}
        fetch={fetch as typeof globalThis.fetch}
      />,
    );
    expect(text(await screen.findByTestId('viewer-name'))).toMatch('Bracket');
    expect(fetch).toHaveBeenCalledWith(
      'https://files.example/b.mfkview',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('refuses a link that is not https', async () => {
    const { factory } = fakeEngine();
    const fetch = vi.fn();
    const location = { ...VIEWER, hash: '#src=http://files.example/b.mfkview' };
    render(
      <ViewerApp
        createEngine={factory}
        location={location}
        fetch={fetch as typeof globalThis.fetch}
      />,
    );
    expect(text(await screen.findByTestId('viewer-error'))).toMatch(/https/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('offers the source to a new app tab only when asked', async () => {
    const { factory } = fakeEngine();
    const offer = vi.fn<typeof offerSource>(() => () => {});
    render(<ViewerApp createEngine={factory} location={VIEWER} offer={offer} />);
    pick(fileOf(await boxBundle({ source: new Uint8Array([1, 2, 3]) })));
    const button = await screen.findByTestId('viewer-open-app');
    expect(offer).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(offer).toHaveBeenCalledTimes(1);
    const [name, source, options] = offer.mock.calls[0]!;
    expect(name).toBe('Bracket');
    expect([...source]).toEqual([1, 2, 3]);
    expect(options.appUrl).toBe('https://viewer.example/');
  });

  it('measures between two points on the model', async () => {
    const { factory, engine } = fakeEngine();
    render(<ViewerApp createEngine={factory} location={VIEWER} />);
    pick(fileOf(await boxBundle()));
    fireEvent.click(await screen.findByTestId('viewer-measure'));
    const delegate = engine.setPointerDelegate.mock.calls.at(-1)![0]!;
    const surface = (engine as unknown as { surfacePoint: ReturnType<typeof vi.fn> }).surfacePoint;
    surface.mockReturnValueOnce([0, 0, 20]).mockReturnValueOnce([30, 40, 20]);
    act(() => {
      delegate.down({} as PointerEvent, { x: 1, y: 1 });
      delegate.down({} as PointerEvent, { x: 2, y: 2 });
    });
    expect(text(screen.getByTestId('viewer-distance'))).toMatch(/^50(\.0+)? mm/);
    fireEvent.click(screen.getByTestId('viewer-measure'));
    expect(engine.setPointerDelegate).toHaveBeenLastCalledWith(null);
  });
});
