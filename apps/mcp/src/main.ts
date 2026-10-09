// The MCP server over stdio: `pnpm --filter @manufakture/mcp start`, configured from the
// environment (config.ts). stdout carries the protocol only; every log line goes to stderr.
// On end of input or a signal, every session is closed (its branch stays) and the process ends.

// First, before anything that may print: stdout is the transport's alone (stdout.ts).
import { flushProtocol, protocolOut } from './stdout';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { createMcpServer } from './server';

const log = (line: string) => process.stderr.write(`manufakture-mcp: ${line}\n`);

const loaded = await loadConfig();
if (!loaded.ok) {
  for (const p of loaded.problems) log(p);
  process.exit(2);
}
for (const w of loaded.warnings) log(`warning: ${w}`);

const app = createMcpServer({ config: loaded.config, log });
const transport = new StdioServerTransport(process.stdin, protocolOut);

let ending = false;
async function end(code: number): Promise<void> {
  if (ending) return;
  ending = true;
  await app.close().catch((e: unknown) => log(`closing: ${String(e)}`));
  await flushProtocol();
  process.exit(code);
}

transport.onclose = () => void end(0);
// The client went away under a write (EPIPE): nothing more can be said to it, so end cleanly.
protocolOut.on('error', () => void end(0));
process.stdin.on('end', () => void end(0));
process.on('SIGINT', () => void end(130));
process.on('SIGTERM', () => void end(143));

await app.server.connect(transport);
const { sync, libraryRoot, outputDir, engine } = loaded.config;
// The token is never logged; the server's address is (it is not secret).
const source = sync === null ? `library ${libraryRoot}` : `sync server ${new URL(sync.url).origin}`;
log(
  `ready: ${source}, ${outputDir === null ? 'no output directory' : `output ${outputDir}`}, ${engine} engines`,
);
