// The preview's three.js objects, without a renderer: one line object per buffer (never one per
// move), placed on the part by the WCS frame; draw ranges and the tool marker follow the
// playback; hidden operations are hidden; the stock box and the gizmo are there.

import { toModel, type Vec3 } from '@manufakture/cam';
import { Box3, LineDashedMaterial, LineSegments, Mesh, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { previewGeometry, segmentsBefore } from './geometry';
import { previewJob } from './job';
import { fixtureGeneration } from './preview.test-fixture';
import { PreviewOverlay, frameMatrix, operationColor } from './scene';
import { stockInMachine } from './placement';

function overlay() {
  const data = fixtureGeneration();
  const job = previewJob(data);
  const path = previewGeometry(job.toolpath, { rapidRate: data.rapidRate });
  const o = new PreviewOverlay({
    frame: data.setup.frame,
    stock: stockInMachine(data.setup.stock, data.setup.wcs),
    path,
    colors: new Map([
      ['profile#1', operationColor(0)],
      ['pocket#1', operationColor(1)],
    ]),
    tools: job.tools,
  });
  return { o, path, data };
}

const named = (root: Object3D, prefix: string) => {
  const out: Object3D[] = [];
  root.traverse((c) => {
    if (c.name.startsWith(prefix)) out.push(c);
  });
  return out;
};

describe('PreviewOverlay', () => {
  it('draws one line object per operation and move class', () => {
    const { o, path } = overlay();
    const lines = named(o.root, 'cam-preview-').filter(
      (c): c is LineSegments => c instanceof LineSegments && c.name !== 'cam-preview-wcs',
    );
    expect(o.bufferCount).toBe(path.buffers.length);
    expect(lines.length).toBe(path.buffers.length);
    expect(path.moveCount).toBeGreaterThan(path.buffers.length);
    for (const l of lines) {
      expect(l.material instanceof LineDashedMaterial).toBe(l.name.endsWith('-rapid'));
    }
    o.dispose();
  });

  it('places machine coordinates on the part with the WCS frame', () => {
    const { o, data } = overlay();
    o.root.updateMatrixWorld(true);
    const p: Vec3 = [12, 7, -3];
    const world = new Vector3(...p).applyMatrix4(o.root.matrixWorld);
    const model = toModel(data.setup.frame, p);
    expect(world.toArray().map((v, i) => v - model[i]!)).toEqual(
      [0, 0, 0].map(() => expect.closeTo(0, 9)),
    );
    expect(o.root.matrix.equals(frameMatrix(data.setup.frame))).toBe(true);
    o.dispose();
  });

  it('draws the moves done and puts the tool at the end of the last', () => {
    const { o, path, data } = overlay();
    const tool = () => named(o.root, 'cam-preview-tool').find((t) => t.visible)!;
    o.setProgress(3);
    const lines = path.buffers.map(
      (b) => o.root.getObjectByName(`cam-preview-${b.op}-${b.moveClass}`) as LineSegments,
    );
    path.buffers.forEach((b, i) => {
      expect(lines[i]!.geometry.drawRange.count).toBe(2 * segmentsBefore(b, 3));
    });
    expect(tool().position.toArray()).toEqual([...path.ends.subarray(6, 9)]);
    // On the part: the move's end through the WCS frame.
    const end = [...path.ends.subarray(6, 9)] as [number, number, number];
    const model = toModel(data.setup.frame, end);
    expect(o.toolMarkerPosition()).toEqual(model.map((v) => expect.closeTo(v, 9)));
    o.setProgress(path.moveCount);
    expect(tool().position.toArray()).toEqual([...path.ends.subarray(-3)]);
    // The last moves are the V-bit's: its marker is a cone, a different object from the flat's.
    expect(named(o.root, 'cam-preview-tool').length).toBe(2);
    o.setProgress(0);
    expect(tool().position.toArray()).toEqual([...path.start]);
    o.dispose();
  });

  it('hides the operations asked', () => {
    const { o } = overlay();
    o.setHidden(new Set(['pocket#1']));
    for (const l of named(o.root, 'cam-preview-pocket#1-')) expect(l.visible).toBe(false);
    for (const l of named(o.root, 'cam-preview-profile#1-')) expect(l.visible).toBe(true);
    o.dispose();
  });

  it('shows the stock box and the WCS gizmo at the WCS origin', () => {
    const { o, data } = overlay();
    o.root.updateMatrixWorld(true);
    const stock = o.root.getObjectByName('cam-preview-stock') as Mesh;
    const box = new Box3().setFromObject(stock);
    expect(box.min.toArray()).toEqual([...data.setup.stock.min].map((v) => expect.closeTo(v, 9)));
    expect(box.max.toArray()).toEqual([...data.setup.stock.max].map((v) => expect.closeTo(v, 9)));
    const gizmo = o.root.getObjectByName('cam-preview-wcs')!;
    expect(gizmo.getWorldPosition(new Vector3()).toArray()).toEqual([0, 0, 10]);
    o.dispose();
  });

  it('draws only the stock and gizmo without a toolpath', () => {
    const data = fixtureGeneration();
    const o = new PreviewOverlay({
      frame: data.setup.frame,
      stock: stockInMachine(data.setup.stock, data.setup.wcs),
      path: null,
      colors: new Map(),
      tools: new Map(),
    });
    expect(o.bufferCount).toBe(0);
    expect(named(o.root, 'cam-preview-tool')).toEqual([]);
    expect(o.root.getObjectByName('cam-preview-stock')).toBeDefined();
    o.dispose();
  });
});
