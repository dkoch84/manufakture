// Text worker entry: lays out text and outlines its glyphs (`TextEngine`), started by the regen
// worker under a watchdog (`spawnTextWorker`, `createWatchdogOutliner`), so a font that hangs or
// exhausts memory costs this worker, never the regen worker (ADR 0011's amendment).

import { TextEngine, serveText } from './text-engine';

serveText(self as unknown as Parameters<typeof serveText>[0], new TextEngine());
