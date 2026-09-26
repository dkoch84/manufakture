// A minimal request/reply protocol for the solver worker: each call is one
// message `{ id, method, args }` answered by `{ id, ok, value | message }`.
// Drag coordinates are transferred, not copied (ADR 0007, decision 6).
//
// ADR 0007 names Comlink for every worker call. This package does not depend
// on Comlink yet, so the worker speaks this protocol; `SolverService` is a
// plain object with async methods and plain data, so switching the entry to
// `Comlink.expose(createSolverService())` changes nothing else.

import type { SketchSolverApi } from './service';

/** The parts of a MessagePort or a worker global scope the protocol uses. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** MessagePorts need it when listening through addEventListener. */
  start?: () => void;
}

export type SolverMethod = keyof SketchSolverApi;

export interface SolverRequest {
  id: number;
  method: SolverMethod;
  args: unknown[];
}

export type SolverReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

const METHODS: readonly SolverMethod[] = [
  'solve',
  'update',
  'dragStart',
  'dragMove',
  'dragEnd',
  'close',
];

function transferables(value: unknown): Transferable[] {
  if (value && typeof value === 'object' && 'coordinates' in value) {
    const c = (value as { coordinates: unknown }).coordinates;
    if (c instanceof Float64Array) return [c.buffer as ArrayBuffer];
  }
  return [];
}

/** Answer solver requests arriving on `endpoint` with `api`. */
export function serveSolver(endpoint: MessageEndpoint, api: SketchSolverApi): void {
  endpoint.addEventListener('message', (event) => {
    const request = event.data as SolverRequest;
    if (!request || typeof request.id !== 'number') return;
    const reply = (r: SolverReply, transfer: Transferable[] = []) =>
      endpoint.postMessage(r, transfer);
    if (!METHODS.includes(request.method)) {
      reply({
        id: request.id,
        ok: false,
        message: `Unknown solver method '${String(request.method)}'`,
      });
      return;
    }
    const call = api[request.method] as (...args: unknown[]) => Promise<unknown>;
    Promise.resolve()
      .then(() => call.apply(api, request.args))
      .then(
        (value) => reply({ id: request.id, ok: true, value }, transferables(value)),
        (e: unknown) =>
          reply({ id: request.id, ok: false, message: e instanceof Error ? e.message : String(e) }),
      );
  });
  endpoint.start?.();
}

/** A typed proxy for a solver served on the other side of `endpoint`. */
export function connectSolver(endpoint: MessageEndpoint): SketchSolverApi {
  let next = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  endpoint.addEventListener('message', (event) => {
    const reply = event.data as SolverReply;
    const w = reply && waiting.get(reply.id);
    if (!w) return;
    waiting.delete(reply.id);
    if (reply.ok) w.resolve(reply.value);
    else w.reject(new Error(reply.message));
  });
  endpoint.start?.();
  const call =
    (method: SolverMethod) =>
    (...args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        endpoint.postMessage({ id, method, args } satisfies SolverRequest, []);
      });
  return Object.fromEntries(METHODS.map((m) => [m, call(m)])) as unknown as SketchSolverApi;
}
