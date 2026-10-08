// Detail crops for the write-up: the same region of the 1024 x 768 iso renders of approach 1
// (software) and approach 2 (HLR through sharp), cut at the renders' own pixels and enlarged 2x
// with nearest-neighbour sampling, side by side, so the legibility of small features at 1024 px
// can be judged. Reads the scratch renders of software.test.ts and hlr.test.ts (run those first).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { it } from 'vitest';
import { IMAGES, SCRATCH, writeImage } from './results';

const require = createRequire(import.meta.url);
const sharp: typeof import('sharp').default = require(
  join(import.meta.dirname, '../../../node_modules/.pnpm/node_modules/sharp'),
);

/** Regions of the iso renders, in output pixels: the bracket's holes, the bookshelf's top corner, the shed's eave and window. */
const CROPS = {
  bracket: { left: 440, top: 450, width: 256, height: 176 },
  bookshelf: { left: 350, top: 30, width: 256, height: 176 },
  shed: { left: 120, top: 220, width: 256, height: 176 },
} as const;

const inputs = (name: string) => [
  join(SCRATCH, `software-${name}-iso.png`),
  join(SCRATCH, `hlr-sharp-${name}-iso.png`),
];

it.skipIf(!Object.keys(CROPS).every((n) => inputs(n).every((f) => existsSync(f))))(
  'writes the detail crops',
  async () => {
    for (const [name, crop] of Object.entries(CROPS)) {
      const tiles = await Promise.all(
        inputs(name).map((f) =>
          sharp(f)
            .extract(crop)
            .resize(crop.width * 2, crop.height * 2, { kernel: 'nearest' })
            .toBuffer(),
        ),
      );
      const gap = 8;
      const out = await sharp({
        create: {
          width: crop.width * 4 + gap,
          height: crop.height * 2,
          channels: 3,
          background: '#ffffff',
        },
      })
        .composite(tiles.map((input, i) => ({ input, left: i * (crop.width * 2 + gap), top: 0 })))
        .png({ compressionLevel: 9 })
        .toBuffer();
      writeImage(IMAGES, `detail-${name}.png`, new Uint8Array(out));
    }
  },
);
