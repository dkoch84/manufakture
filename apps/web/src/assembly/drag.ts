// Dragging an instance in the viewport (M2 plan, T2.3e): a left-button drag on an instance that
// is not fixed grabs the point under the cursor, and every pointer move asks the regen worker to
// move that point toward the cursor (on the plane through the grabbed point facing the viewer)
// within the freedom the mates leave. The worker coalesces the steps (latest target wins), so
// the main thread only shows the poses each answer brings. On release the poses of the instances
// that moved are committed with one `setPoses`: one undo step per drag, never one per frame. A
// drag that commits nothing (cancelled, or nothing moved) ends the worker's drag too, so the next
// one starts from what the screen shows, not from where the last step left the instances.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import type { Vec3 } from '@manufakture/kernel';
import type { DragResult } from '@manufakture/regen';
import type { GeometryRef } from '../state/selection';
import { untransformPoint } from '../viewport/bodies';
import type { CanvasPoint, ObjectDrag } from '../viewport/engine';
import type { ViewportApi } from '../viewport/Viewport';
import { instanceOf, type Assembler } from './assembly';

export interface DragHost {
  viewport: Pick<ViewportApi, 'surfacePoint' | 'viewDirection' | 'canvasToPlane'>;
  assembler: Assembler;
  /** The assembly shown, or null when none is (nothing is dragged then). */
  assemblyId(): string | null;
  document(): ManufaktureDocument;
  /** Where an instance is shown now. */
  transformOf(instanceId: string): Pose | undefined;
  /** Show these poses in place of the solved ones while dragging. */
  show(assemblyId: string, poses: ReadonlyMap<string, Pose>): void;
  /** The drag ended: commit `poses` (instances that moved) as one step, or nothing (null). */
  done(assemblyId: string, poses: Record<string, Pose> | null, label: string): void;
  /** A drag that cannot start, said in a sentence (a fixed instance). */
  refuse(message: string): void;
}

interface Grab {
  assemblyId: string;
  instanceId: string;
  name: string;
  /** The grabbed point in the instance's coordinates. */
  local: Vec3;
  /** The grabbed point in the world, and the plane the cursor moves it on. */
  world: Vec3;
  normal: Vec3;
  /** The newest step asked for, and the newest answer. */
  pending: Promise<DragResult | null> | null;
  last: DragResult | null;
}

/** The viewport's object drag for instances of the assembly `host` shows. */
export function instanceDrag(host: DragHost): ObjectDrag {
  let grab: Grab | null = null;

  return {
    start(ref: GeometryRef | null, p: CanvasPoint): boolean {
      const assemblyId = host.assemblyId();
      if (ref === null || assemblyId === null) return false;
      const instanceId = instanceOf(ref.bodyId, assemblyId);
      if (instanceId === null) return false;
      const instance = host
        .document()
        .assemblies.find((a) => a.id === assemblyId)
        ?.instances.find((x) => x.id === instanceId);
      if (!instance) return false;
      if (instance.fixed) {
        host.refuse(`${instance.name} is fixed: unfix it to drag it.`);
        return false;
      }
      const world = host.viewport.surfacePoint(p.x, p.y);
      const pose = host.transformOf(instanceId);
      if (world === null || pose === undefined) return false;
      grab = {
        assemblyId,
        instanceId,
        name: instance.name,
        local: untransformPoint(pose, world),
        world,
        normal: host.viewport.viewDirection(),
        pending: null,
        last: null,
      };
      return true;
    },

    move(p: CanvasPoint): void {
      const g = grab;
      if (!g) return;
      const position = host.viewport.canvasToPlane(p.x, p.y, g.world, g.normal);
      if (position === null) return;
      const step = host.assembler.drag(g.assemblyId, g.instanceId, {
        point: g.local,
        position,
      });
      g.pending = step;
      void step.then(
        (r) => {
          if (r === null || grab !== g) return;
          g.last = r;
          host.show(g.assemblyId, new Map(Object.entries(r.transforms)));
        },
        () => undefined,
      );
    },

    end(p: CanvasPoint | null): void {
      const g = grab;
      grab = null;
      if (!g) return;
      const label = `Drag ${g.name}`;
      if (p === null || g.pending === null) {
        uncommitted(g, label);
        return;
      }
      // The newest step is the one that counts: wait for it (older ones resolved to null).
      void g.pending.then(
        (r) => finish(g, r ?? g.last, label),
        () => finish(g, g.last, label),
      );
    },
  };

  function uncommitted(g: Grab, label: string): void {
    host.assembler.endDrag?.(g.assemblyId);
    host.done(g.assemblyId, null, label);
  }

  function finish(g: Grab, r: DragResult | null, label: string): void {
    if (r === null || r.moved.length === 0) {
      uncommitted(g, label);
      return;
    }
    host.show(g.assemblyId, new Map(Object.entries(r.transforms)));
    const poses: Record<string, Pose> = {};
    for (const id of r.moved) poses[id] = r.transforms[id]!;
    host.done(g.assemblyId, poses, label);
  }
}
