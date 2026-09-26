// The app's test hook (see src/viewport/Viewport.tsx), as seen from
// Playwright's page.evaluate callbacks. Declared here, narrowed to what the
// specs use, so the e2e typecheck does not compile the app.

interface E2eItem {
  kind: string;
  id: string;
  name?: string;
  placeholder?: boolean;
  fragile?: boolean;
}

interface E2eFrameStats {
  frames: number;
  triangles: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  renderCpuMs: number;
}

interface E2eGeometrySample {
  bodyId: string;
  kind: 'edge' | 'vertex';
  name: string;
  points: [number, number, number][];
}

interface Window {
  __manufakture?: {
    viewport: {
      info(): {
        bodies: { id: string; faces: number; edges: number; triangles: number }[];
        projection: string;
        halfHeight: number;
        animating: boolean;
      };
      projectToClient(p: readonly [number, number, number]): { x: number; y: number };
      setStandardView(
        view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso',
        animate?: boolean,
      ): void;
      measureFrames(frames?: number): Promise<E2eFrameStats>;
      pickAt(x: number, y: number): E2eItem | null;
      geometrySamples(): E2eGeometrySample[];
      hiddenDepth(
        points: readonly (readonly [number, number, number])[],
        marginPx?: number,
      ): number[];
    };
    selection: {
      getState(): {
        selected: readonly E2eItem[];
        hovered: E2eItem | null;
        setKindEnabled(kind: string, enabled: boolean): void;
        clear(): void;
      };
    };
    settings: {
      getState(): { projection: string; setSection(patch: Record<string, unknown>): void };
    };
  };
}
