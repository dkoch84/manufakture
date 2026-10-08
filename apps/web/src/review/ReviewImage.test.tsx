import { render, screen, waitFor } from '@testing-library/react';
import { sha256Hex } from '@manufakture/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_SIDE, checkedRef, imageProblem } from './image';
import { ReviewImage } from './ReviewImage';
import { FIXTURE } from './review.test-fixture';

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const [SHA, B64] = Object.entries(FIXTURE.images)[0]!;
const PNG = bytesOf(B64);
const REF = { sha256: SHA, bytes: PNG.length, width: 320, height: 240 };

const made: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  made.length = 0;
  revoked.length = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => {
        made.push(`blob:${made.length}`);
        return made.at(-1)!;
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('checkedRef', () => {
  it('accepts a reference as the bundle writes one, and nothing else', () => {
    expect(checkedRef(REF)).toEqual(REF);
    expect(checkedRef({ ...REF, sha256: 'not-a-sha' })).toBeNull();
    expect(checkedRef({ ...REF, sha256: `${SHA.slice(0, 63)}G` })).toBeNull();
    expect(checkedRef({ ...REF, bytes: 0 })).toBeNull();
    expect(checkedRef({ ...REF, bytes: 9 * 1024 * 1024 })).toBeNull();
    expect(checkedRef({ ...REF, width: MAX_IMAGE_SIDE + 1 })).toBeNull();
    expect(checkedRef({ ...REF, height: 1.5 })).toBeNull();
    expect(checkedRef({ ...REF, width: '320' })).toBeNull();
    expect(checkedRef('javascript:alert(1)')).toBeNull();
    expect(checkedRef(null)).toBeNull();
  });
});

describe('imageProblem', () => {
  it('passes the bytes the reference names, and nothing else', async () => {
    expect(await sha256Hex(PNG)).toBe(SHA);
    expect(await imageProblem(PNG, REF)).toBeNull();
    expect(await imageProblem(PNG.slice(0, -1), REF)).toMatch(/size/);
    const flipped = PNG.slice();
    flipped[40] = flipped[40]! ^ 1;
    expect(await imageProblem(flipped, REF)).toMatch(/SHA-256/);
    expect(await imageProblem(PNG, { ...REF, width: 321 })).toMatch(/width and height/);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(
      await imageProblem(svg, { ...REF, bytes: svg.length, sha256: await sha256Hex(svg) }),
    ).toMatch(/not a PNG/);
  });
});

describe('ReviewImage', () => {
  it('shows a checked PNG through a blob URL, and revokes it when it goes', async () => {
    const read = vi.fn(async () => PNG);
    const view = render(<ReviewImage value={REF} alt="isometric, head" read={read} testId="img" />);
    await waitFor(() => expect(screen.getByTestId('img').dataset.state).toBe('ok'));
    const img = screen.getByTestId('img') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('blob:0');
    expect(img.getAttribute('width')).toBe('320');
    expect(read).toHaveBeenCalledWith(SHA);
    view.unmount();
    expect(revoked).toEqual(['blob:0']);
  });

  it('shows why not, as text, when the bytes do not check out or are missing', async () => {
    render(<ReviewImage value={REF} alt="a" read={async () => PNG.slice(1)} testId="a" />);
    await waitFor(() => expect(screen.getByTestId('a').dataset.state).toBe('error'));
    expect(screen.getByTestId('a').textContent).toMatch(/size/);
    render(<ReviewImage value={REF} alt="b" read={async () => null} testId="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toMatch(/not stored/));
    render(<ReviewImage value={{ sha256: '../x' }} alt="c" read={async () => PNG} testId="c" />);
    expect(screen.getByTestId('c').dataset.state).toBe('invalid');
    render(
      <ReviewImage
        value={null}
        missing="<b>Nothing to draw</b>"
        alt="d"
        read={async () => PNG}
        testId="d"
      />,
    );
    expect(screen.getByTestId('d').textContent).toBe('<b>Nothing to draw</b>');
    expect(made).toEqual([]);
  });
});
