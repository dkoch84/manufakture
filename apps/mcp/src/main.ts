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
process.stdin.on('end', () => void end(0));
process.on('SIGINT', () => void end(130));
process.on('SIGTERM', () => void end(143));

await app.server.connect(transport);
log(
  `ready: library ${loaded.config.libraryRoot}, ${loaded.config.outputDir === null ? 'no output directory' : `output ${loaded.config.outputDir}`}, ${loaded.config.engine} engines${loaded.config.sync === null ? '' : ', sync configured (not used yet)'}`,
);
