import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMON_HEADERS,
  DOCUMENT_CSP,
  HASHED_ASSET_PATH,
  IMMUTABLE,
  REVALIDATE,
  WORKER_CSP,
  WORKER_SCRIPT_PATH,
  headersFor,
  localPolicy,
} from './headers';

// jsdom gives import.meta.url an http address; __dirname is this file's directory.
const caddyfile = readFileSync(resolve(__dirname, '../../../../deploy/Caddyfile'), 'utf8');

describe('headersFor', () => {
  it('caches hashed assets for good and revalidates everything else', () => {
    expect(headersFor('/assets/main-DVEPSJbO.css')['Cache-Control']).toBe(IMMUTABLE);
    expect(headersFor('/assets/opencascade_single-B9DBEong.wasm')['Cache-Control']).toBe(IMMUTABLE);
    for (const path of [
      '/',
      '/index.html',
      '/viewer.html',
      '/source.html',
      '/sw.js',
      '/manifest.webmanifest',
      '/icons/icon.svg',
    ]) {
      expect(headersFor(path)['Cache-Control'], path).toBe(REVALIDATE);
    }
  });

  it('gives worker scripts the worker policy and pages the strict one', () => {
    expect(headersFor('/assets/regen-worker-Di5uZo1s.js')['Content-Security-Policy']).toBe(
      WORKER_CSP,
    );
    expect(headersFor('/assets/worker-BTh-McJO.js')['Content-Security-Policy']).toBe(WORKER_CSP);
    expect(headersFor('/index.html')['Content-Security-Policy']).toBe(DOCUMENT_CSP);
    expect(headersFor('/assets/main-dfJw0TYN.js')['Content-Security-Policy']).toBe(DOCUMENT_CSP);
    expect(headersFor('/sw.js')['Content-Security-Policy']).toBe(DOCUMENT_CSP);
  });

  it('keeps eval out of pages; only workers may, for the kernel glue', () => {
    expect(DOCUMENT_CSP).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(DOCUMENT_CSP).not.toContain("'unsafe-eval'");
    expect(DOCUMENT_CSP).not.toContain("'unsafe-inline'");
    expect(DOCUMENT_CSP).toContain("frame-ancestors 'none'");
    expect(WORKER_CSP).toContain("'unsafe-eval'");
  });

  it('widens connect-src for localhost only in the local variant', () => {
    expect(DOCUMENT_CSP).toContain("connect-src 'self' https:;");
    expect(localPolicy(DOCUMENT_CSP)).toContain('http://localhost:*');
    expect(headersFor('/', { local: true })['Content-Security-Policy']).toContain(
      'http://127.0.0.1:*',
    );
    expect(headersFor('/')['Content-Security-Policy']).not.toContain('http:');
  });

  it('sends no COEP: nothing needs cross-origin isolation', () => {
    expect(Object.keys(headersFor('/'))).not.toContain('Cross-Origin-Embedder-Policy');
  });
});

describe('deploy/Caddyfile', () => {
  it('sends the same policies', () => {
    expect(caddyfile).toContain(`header @page Content-Security-Policy "${DOCUMENT_CSP}"`);
    expect(caddyfile).toContain(`header @worker Content-Security-Policy "${WORKER_CSP}"`);
  });

  it('sends the same common headers and cache rules', () => {
    for (const [name, value] of Object.entries(COMMON_HEADERS)) {
      expect(caddyfile).toContain(`${name} "${value}"`);
    }
    expect(caddyfile).toContain(`header @hashed Cache-Control "${IMMUTABLE}"`);
    expect(caddyfile).toContain(`header @unhashed Cache-Control "${REVALIDATE}"`);
    expect(caddyfile).not.toContain('Cross-Origin-Embedder-Policy');
  });

  it('matches hashed assets and worker scripts with the same patterns', () => {
    const hashed = HASHED_ASSET_PATH.source.replace(/\\\//g, '/');
    const worker = WORKER_SCRIPT_PATH.source.replace(/\\\//g, '/');
    expect(caddyfile).toContain(`@hashed path_regexp ${hashed}`);
    expect(caddyfile).toContain(`@worker path_regexp ${worker}`);
  });
});
