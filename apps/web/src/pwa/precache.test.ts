import { describe, expect, it } from 'vitest';
import { choosePrecache, PRECACHE_SIZE_LIMIT, type ManifestEntry } from './precache';

const entry = (url: string, size: number, revision: string | null = null): ManifestEntry => ({
  url,
  size,
  revision,
});

describe('choosePrecache', () => {
  const build = [
    entry('index.html', 2267, 'abc'),
    entry('assets/index-CvWH284h.js', 877_544),
    entry('assets/planegcs-r8EUavAY.wasm', 508_141),
    entry('assets/manifold-BE4c7gO-.wasm', 541_470),
    entry('assets/opencascade_single-B9DBEong.wasm', 42_691_285),
    entry('assets/web-ifc-BDaIXFUT.wasm', 1_595_268),
    entry('assets/web-ifc-api-Cnxq4EOU.js', 3_540_029),
  ];

  it('keeps the shell, planegcs and the kernel, and carries each size as bytes', () => {
    const { manifest, warnings } = choosePrecache(build);
    expect(manifest.map((e) => e.url)).toEqual([
      'index.html',
      'assets/index-CvWH284h.js',
      'assets/planegcs-r8EUavAY.wasm',
      'assets/manifold-BE4c7gO-.wasm',
      'assets/opencascade_single-B9DBEong.wasm',
    ]);
    expect(manifest[0]).toEqual({ url: 'index.html', revision: 'abc', bytes: 2267 });
    expect(manifest[4]!.bytes).toBe(42_691_285);
    expect(warnings).toEqual([]);
  });

  it('leaves web-ifc to the runtime cache', () => {
    const urls = choosePrecache(build).manifest.map((e) => e.url);
    expect(urls.some((u) => u.includes('web-ifc'))).toBe(false);
  });

  it('lifts the size limit for the kernel only, and warns about anything else above it', () => {
    const big = entry('assets/huge-Cnxq4EOU.js', PRECACHE_SIZE_LIMIT + 1);
    const { manifest, warnings } = choosePrecache([...build, big]);
    expect(manifest.map((e) => e.url)).not.toContain(big.url);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('assets/huge-Cnxq4EOU.js');
  });

  it('warns when the kernel is missing from the build', () => {
    const { warnings } = choosePrecache(build.filter((e) => !e.url.includes('opencascade')));
    expect(warnings).toEqual([expect.stringContaining('kernel .wasm was not found')]);
  });
});
