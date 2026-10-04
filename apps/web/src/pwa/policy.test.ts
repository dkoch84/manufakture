import { describe, expect, it } from 'vitest';
import { isAppNavigation, isRuntimeCacheable } from './policy';

const SCOPE = 'https://app.example/';
const get = { method: 'GET' };
const at = (path: string) => new URL(path, SCOPE);

describe('isRuntimeCacheable', () => {
  it('allows same-origin GETs of hashed build assets', () => {
    expect(isRuntimeCacheable(at('/assets/web-ifc-api-Cnxq4EOU.js'), get, SCOPE)).toBe(true);
    expect(isRuntimeCacheable(at('/assets/web-ifc-BDaIXFUT.wasm'), get, SCOPE)).toBe(true);
    expect(isRuntimeCacheable(at('/assets/nesting-worker--MR0Wvvm.js'), get, SCOPE)).toBe(true);
  });

  it('never matches another origin, such as a sync server', () => {
    const other = new URL('https://sync.example/assets/x-Cnxq4EOU.js');
    expect(isRuntimeCacheable(other, get, SCOPE)).toBe(false);
    const port = new URL('https://app.example:8443/assets/x-Cnxq4EOU.js');
    expect(isRuntimeCacheable(port, get, SCOPE)).toBe(false);
  });

  it('never matches API paths, unhashed files or other directories', () => {
    expect(isRuntimeCacheable(at('/api/documents'), get, SCOPE)).toBe(false);
    expect(isRuntimeCacheable(at('/assets/data.json'), get, SCOPE)).toBe(false);
    expect(isRuntimeCacheable(at('/assets/sub/x-Cnxq4EOU.js'), get, SCOPE)).toBe(false);
    expect(isRuntimeCacheable(at('/shares/x-Cnxq4EOU.js'), get, SCOPE)).toBe(false);
    expect(isRuntimeCacheable(at('/index.html'), get, SCOPE)).toBe(false);
  });

  it('never matches non-GET, range or query-string requests', () => {
    const url = at('/assets/x-Cnxq4EOU.js');
    expect(isRuntimeCacheable(url, { method: 'POST' }, SCOPE)).toBe(false);
    const range = { method: 'GET', headers: new Headers({ range: 'bytes=0-10' }) };
    expect(isRuntimeCacheable(url, range, SCOPE)).toBe(false);
    expect(isRuntimeCacheable(at('/assets/x-Cnxq4EOU.js?token=1'), get, SCOPE)).toBe(false);
  });

  it('respects a scope below the origin root', () => {
    const scope = 'https://host.example/app/';
    const inside = new URL('https://host.example/app/assets/x-Cnxq4EOU.js');
    const outside = new URL('https://host.example/assets/x-Cnxq4EOU.js');
    expect(isRuntimeCacheable(inside, get, scope)).toBe(true);
    expect(isRuntimeCacheable(outside, get, scope)).toBe(false);
  });
});

describe('isAppNavigation', () => {
  it('answers app paths with the shell', () => {
    expect(isAppNavigation(at('/'), SCOPE)).toBe(true);
    expect(isAppNavigation(at('/?doc=abc&branch=main'), SCOPE)).toBe(true);
    expect(isAppNavigation(at('/some/route'), SCOPE)).toBe(true);
  });

  it('leaves files, API paths and other origins to the network', () => {
    expect(isAppNavigation(at('/api'), SCOPE)).toBe(false);
    expect(isAppNavigation(at('/api/shares/x'), SCOPE)).toBe(false);
    expect(isAppNavigation(at('/LICENSE.txt'), SCOPE)).toBe(false);
    expect(isAppNavigation(at('/other.html'), SCOPE)).toBe(false);
    expect(isAppNavigation(new URL('https://elsewhere.example/'), SCOPE)).toBe(false);
    expect(isAppNavigation(new URL('https://host.example/'), 'https://host.example/app/')).toBe(
      false,
    );
  });
});
