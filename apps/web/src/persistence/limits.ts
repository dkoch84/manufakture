// Limits the app checks before it reads a file, kept apart from mfk.ts so that checking one does
// not load the zip code.

/** The largest `.mfk` file read at all: a larger one is refused before its bytes are read. */
export const MAX_MFK_FILE_BYTES = 256 * 1024 * 1024;
