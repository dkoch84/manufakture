// IFC export in the regen worker (T6.6a): `exportIfc` writes a building with `@manufakture/io`'s
// writer, loading web-ifc on the first call, and answers over the worker channel with the file's
// bytes. No kernel is involved: the kernel never loads here.

import type { IfcBuildingInput } from '@manufakture/io';
import * as Comlink from 'comlink';
import { afterAll, describe, expect, it } from 'vitest';
import { createRegenWorkerApi, type RegenWorkerApi } from './worker-api';

const channels: MessagePort[] = [];
// Kept: Comlink closes a proxy's port when the proxy is garbage collected, which a first export
// (loading web-ifc) gives the collector time to do, and the reply is lost.
const proxies: Comlink.Remote<RegenWorkerApi>[] = [];

afterAll(() => {
  for (const p of channels) p.close();
});

function remote(): Comlink.Remote<RegenWorkerApi> {
  const api = createRegenWorkerApi({ source: { url: 'never-loaded.wasm' } });
  const { port1, port2 } = new MessageChannel();
  channels.push(port1, port2);
  Comlink.expose(api, port1);
  const proxy = Comlink.wrap<RegenWorkerApi>(port2);
  proxies.push(proxy);
  return proxy;
}

const building: IfcBuildingInput = {
  documentId: 'doc-1',
  name: 'Wall',
  unit: 'mm',
  disclaimer: 'Not an engineering tool.',
  levels: [{ id: 'level-1', name: 'Level 1', elevation: 0 }],
  walls: [
    {
      id: 'wall#1',
      level: 'level-1',
      base: 0,
      height: 2400,
      points: [
        [0, 0],
        [3000, 0],
      ],
      closed: false,
      thickness: 89,
    },
  ],
};

describe('exportIfc in the regen worker', () => {
  it('writes the building as IFC4 and sends the bytes back', async () => {
    const bytes = await remote().exportIfc(building);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(text).toContain("IFCWALL('");
  });

  it("rejects with the writer's message when the building is malformed", async () => {
    await expect(remote().exportIfc({ ...building, levels: [] })).rejects.toThrow(
      /at least one level/,
    );
  });
});
