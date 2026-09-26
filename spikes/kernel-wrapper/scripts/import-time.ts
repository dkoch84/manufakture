// Time importing one wrapper library's JS in a fresh process that has imported
// nothing else (no kernel is loaded).
//
//   node scripts/import-time.ts <library>
// prints JSON on the last line.

const library = process.argv[2] ?? 'replicad';
const t0 = performance.now();
await import(library);
const importMs = Math.round((performance.now() - t0) * 100) / 100;
console.log(JSON.stringify({ library, importMs }));
process.exit(0);
