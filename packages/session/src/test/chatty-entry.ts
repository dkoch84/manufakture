// A session worker that prints to its stdout before it serves as the real one does: the worker
// test checks that the line reaches the host's stderr, never its stdout.

console.log('chatty worker: a line on stdout');
await import('../worker/entry');
