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

type E2eVec2 = [number, number];

interface E2eSketchEntity {
  id: string;
  kind: 'point' | 'line' | 'circle' | 'arc';
  construction: boolean;
  start?: E2eVec2;
  end?: E2eVec2;
  center?: E2eVec2;
  radius?: number;
  position?: E2eVec2;
}

interface E2eSketchConstraint {
  id: string;
  kind: string;
  value?: { source: string; lengthUnit: string; angleUnit: string };
}

interface E2eSketchState {
  active: boolean;
  sketch: { entities: E2eSketchEntity[]; constraints: E2eSketchConstraint[] };
  solve: {
    status: string;
    diagnosis: { dof: number | null; conflicting: string[]; redundant: string[] };
  } | null;
  solving: boolean;
  source: { featureId: string; placement: { origin: number[]; normal: number[] } } | null;
  idle(): Promise<void>;
}

interface E2eFeature {
  id: string;
  kind: string;
  name: string;
  entities?: E2eSketchEntity[];
  constraints?: E2eSketchConstraint[];
  plane?: { type: string; origin?: number[]; normal?: number[] };
  source?: { format: string; fileName: string; size: number; sha256: string; data: string };
  operation?: string;
}

interface E2eFeatureResult {
  featureId: string;
  kind: string;
  status: string;
  cached: boolean;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  references: { referenceId: string; target: string; via: string; fragile: boolean }[];
}

interface Window {
  __manufakture?: {
    model: {
      getState(): {
        generation: number;
        pending: boolean;
        /** Milliseconds the last regen took in the worker. */
        ms: number;
        document: unknown;
        parts: { partId: string; features: E2eFeatureResult[] }[];
      };
    };
    sketcher: {
      store: { getState(): E2eSketchState };
      toClient(p: E2eVec2): { x: number; y: number };
    };
    document: {
      getState(): {
        document: { parts: { features: E2eFeature[] }[] };
        canUndo: boolean;
        execute(command: unknown, label?: string): { ok: boolean };
      };
    };
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
    measure: {
      getState(): {
        status: string;
        request: { targets: unknown[] } | null;
        result: {
          distance: { value: number; from: number[]; to: number[] } | null;
          body: { volume: number } | null;
        } | null;
      };
    };
  };
}
