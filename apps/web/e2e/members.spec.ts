import { readFile } from 'node:fs/promises';
import { validate3mf } from '@manufakture/io';
import { expect, test, type Page } from '@playwright/test';
import { openScene, settle, type Vec3 } from './helpers';

// Framing members in the viewport (T6.5c): instanced drawing, picking a member as a whole, its
// info panel, hiding a wall layer, the level cut, 3MF export and a frame time on the house.
// No construction UI exists yet, so the members come from the app's framing fixtures
// (src/viewport/memberFixtures.ts): `?scene=framing` shows a fixture with no kernel, and the
// `loadMemberFixture` hook loads one next to a kernel part for the export check.

interface MemberStats {
  sets: number;
  members: number;
  shapes: number;
  drawCalls: number;
  triangles: number;
  edgesShown: number;
  visible: boolean;
  hiddenLayers: string[];
  levelCut: unknown;
  clipPlanes: number;
}

interface PickItem {
  kind: string;
  id: string;
  bodyId?: string;
}

/** The hooks this spec uses beyond global.d.ts's. */
interface MemberHooks {
  viewport: {
    memberInfo(): MemberStats;
    memberColor(id: string): string | null;
    pickAt(x: number, y: number): PickItem | null;
    setHiddenLayers(layers: string[]): void;
    setLevelCut(
      cut: { elevation: number; cutHeight?: number | null; below?: number | null } | null,
    ): void;
    setViewDirection(dir: readonly [number, number, number], animate?: boolean): void;
    frameBox(box: { min: Vec3; max: Vec3 }, animate?: boolean): void;
    projectToClient(p: readonly [number, number, number]): { x: number; y: number };
    measureFrames(
      frames?: number,
    ): Promise<{ meanMs: number; p95Ms: number; frames: number; triangles: number }>;
  };
  loadMemberFixture(name: 'shed' | 'house', partId?: string): Promise<void>;
  document: { getState(): { activePartId: string } };
}

const IN = 25.4;
/** The south wall's third stud (on the 32" mark), a point on its outside face. */
const STUD = 'wall-s:s3';
const studAt = (z: number): Vec3 => [32 * IN + 19.05, 0, z];
/** The upper top plate of the south wall, at 3' along. */
const TOP_PLATE: Vec3 = [36 * IN, 0, 38.1 + 92.625 * IN + 38.1 + 19];

function stats(page: Page): Promise<MemberStats> {
  return page.evaluate(() =>
    (window.__manufakture as unknown as MemberHooks).viewport.memberInfo(),
  );
}

/** What the cursor picks over a world point (canvas coordinates from the page's). */
async function pickWorld(page: Page, p: Vec3): Promise<PickItem | null> {
  return page.evaluate((q) => {
    const vp = (window.__manufakture as unknown as MemberHooks).viewport;
    const c = vp.projectToClient(q);
    const rect = document.querySelector('[data-testid="viewport-canvas"]')!.getBoundingClientRect();
    return vp.pickAt(c.x - rect.left, c.y - rect.top);
  }, p);
}

/** Look at the south wall from outside, close enough that a stud is many pixels wide. */
async function faceSouthWall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = (window.__manufakture as unknown as MemberHooks).viewport;
    vp.setViewDirection([0.15, -1, 0.1], false);
    vp.frameBox({ min: [0, -50, 0], max: [1800, 50, 2500] }, false);
  });
  await settle(page);
}

async function rendererName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
}

test.describe('framing members', () => {
  test('the shed renders instanced; a stud picks, highlights and shows its data', async ({
    page,
  }) => {
    await openScene(page, '?scene=framing&fixture=shed');
    await page.waitForFunction(
      () => (window.__manufakture as unknown as MemberHooks).viewport.memberInfo().members > 0,
    );
    const s = await stats(page);
    expect(s.sets).toBe(4);
    expect(s.members).toBe(73);
    // One draw call per shape (plus a group's edges): far fewer than one per member.
    expect(s.shapes).toBeLessThan(20);
    expect(s.drawCalls).toBeLessThanOrEqual(s.shapes + s.sets);

    await faceSouthWall(page);
    // The sheathing covers the framing from outside.
    const covered = await pickWorld(page, studAt(1000));
    expect(covered?.kind).toBe('face');
    expect(covered?.bodyId).toBe('shed/wall-s:layer/sheathing');

    // Hiding the sheathing layer shows the framing: the stud picks, as a whole.
    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.setHiddenLayers(['sheathing']),
    );
    await settle(page);
    expect(await pickWorld(page, studAt(1000))).toMatchObject({ kind: 'member', id: STUD });
    expect(await pickWorld(page, studAt(2000))).toMatchObject({ kind: 'member', id: STUD });

    // Hover and click: it highlights, and the info panel shows its stock and length.
    const roleColor = await page.evaluate(
      (id) => (window.__manufakture as unknown as MemberHooks).viewport.memberColor(id),
      STUD,
    );
    const { x, y } = await page.evaluate(
      (q) => (window.__manufakture as unknown as MemberHooks).viewport.projectToClient(q),
      studAt(1000),
    );
    await page.mouse.move(x, y);
    await page.waitForFunction(
      (id) => window.__manufakture!.selection.getState().hovered?.id === id,
      STUD,
    );
    await page.mouse.click(x, y);
    await expect
      .poll(() => page.evaluate(() => window.__manufakture!.selection.getState().selected))
      .toEqual([{ kind: 'member', id: STUD, owner: 'wall-s' }]);
    const selectedColor = await page.evaluate(
      (id) => (window.__manufakture as unknown as MemberHooks).viewport.memberColor(id),
      STUD,
    );
    expect(selectedColor).not.toBe(roleColor);
    const info = page.getByTestId('member-info');
    await expect(info.getByRole('heading')).toHaveText('Stud');
    await expect(page.getByTestId('member-info-id')).toHaveText(STUD);
    await expect(page.getByTestId('member-info-stock')).toHaveText(
      /^2x4 \(38\.10 mm x 88\.90 mm\)$/,
    );
    await expect(page.getByTestId('member-info-length')).toHaveText(/^2352\.6[78] mm$/);
    await expect(page.getByTestId('member-info-cuts')).toHaveText('None (square ends)');
    // Escape clears the selection and the panel.
    await page.keyboard.press('Escape');
    await expect(info).toHaveCount(0);
  });

  test('the level cut clips bodies and members alike and shows one level', async ({ page }) => {
    await openScene(page, '?scene=framing&fixture=shed');
    await page.waitForFunction(
      () => (window.__manufakture as unknown as MemberHooks).viewport.memberInfo().members > 0,
    );
    await faceSouthWall(page);

    // A plan cut 4' above the floor: the stud below the cut still picks; above it, nothing of
    // the sheathing or the framing is left in front, and the top plates are gone.
    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.setLevelCut({ elevation: 0 }),
    );
    await settle(page);
    expect((await stats(page)).clipPlanes).toBe(1);
    expect(await pickWorld(page, studAt(1000))).toMatchObject({
      kind: 'face',
      bodyId: 'shed/wall-s:layer/sheathing',
    });
    expect(await pickWorld(page, studAt(2000))).toBeNull();
    expect(await pickWorld(page, TOP_PLATE)).toBeNull();
    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.setHiddenLayers(['sheathing']),
    );
    await settle(page);
    expect(await pickWorld(page, studAt(1000))).toMatchObject({ kind: 'member', id: STUD });

    // One level only: a level at the top plates (8'), nothing under it, no top cut. The studs
    // are gone; the top plate picks.
    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.setLevelCut({
        elevation: 38.1 + 92.625 * 25.4,
        below: 0,
        cutHeight: null,
      }),
    );
    await settle(page);
    expect(await pickWorld(page, studAt(1000))).toBeNull();
    expect(await pickWorld(page, TOP_PLATE)).toMatchObject({ kind: 'member', id: 'wall-s:top2' });

    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.setLevelCut(null),
    );
    await settle(page);
    expect((await stats(page)).clipPlanes).toBe(0);
    expect(await pickWorld(page, studAt(2000))).toMatchObject({ kind: 'member', id: STUD });
  });

  test('3MF export of the shed walls has an object per member next to the bodies', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openScene(page, '?scene=demo', 90_000);
    await page.evaluate(async () => {
      const hooks = window.__manufakture as unknown as MemberHooks;
      await hooks.loadMemberFixture('shed', hooks.document.getState().activePartId);
    });
    await expect.poll(async () => (await stats(page)).members).toBe(73);

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-3mf').click(),
    ]);
    const bytes = new Uint8Array(await readFile(await download.path()));
    const report = validate3mf(bytes);
    expect(report.problems).toEqual([]);
    const names = report.parsed!.objects.map((o) => o.name);
    expect(names[0]).toBe('Demo part');
    expect(names).toHaveLength(1 + 73);
    expect(names).toContain(STUD);
    expect(names).toContain('door-1:king-l');
    expect(names).toContain('window-1:sill');
    await expect(page.getByTestId('io-status')).toHaveText(/^Exported Demo part\.3mf/);
  });

  test('reports frame times for the house fixture', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await openScene(page, '?scene=framing&fixture=house', 60_000);
    await page.waitForFunction(
      () => (window.__manufakture as unknown as MemberHooks).viewport.memberInfo().members > 0,
    );
    const renderer = await rendererName(page);
    const measure = async () => ({
      ...(await page.evaluate(() =>
        (window.__manufakture as unknown as MemberHooks).viewport.measureFrames(90),
      )),
      ...(await stats(page)),
    });
    // The whole house fitted: the LOD rule has the member edges off at this distance.
    const fitted = await measure();
    // Close to one wall: its edges are drawn.
    await page.evaluate(() =>
      (window.__manufakture as unknown as MemberHooks).viewport.frameBox(
        { min: [0, -100, 0], max: [3000, 100, 2500] },
        false,
      ),
    );
    await settle(page);
    const close = await measure();
    // Close, with Show edges off.
    await page.evaluate(() =>
      (
        window.__manufakture!.settings.getState() as unknown as {
          setShowEdges(on: boolean): void;
        }
      ).setShowEdges(false),
    );
    const closeNoEdges = await measure();
    // SwiftShader (software GL): frame times are capped by the 60 Hz animation frame and say
    // nothing about a GPU; renderCpuMs is the CPU side of renderer.render.
    const report = { renderer, fitted, close, closeNoEdges };
    await testInfo.attach('member-frame-times', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    console.log(`member frame times (${renderer}): ${JSON.stringify(report)}`);
    expect(fitted.members).toBeGreaterThan(500);
    expect(fitted.frames).toBe(90);
    expect(fitted.meanMs).toBeGreaterThan(0);
    expect(fitted.drawCalls).toBeLessThan(fitted.members / 10);
    expect(close.edgesShown).toBeGreaterThan(0);
    expect(closeNoEdges.edgesShown).toBe(0);
  });
});
