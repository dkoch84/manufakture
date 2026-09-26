import { createBrepjs } from './brepjs.ts';
import { createOcctWasm } from './occtWasm.ts';
import { createOwn } from './own.ts';
import { createReplicad, createReplicadOnLibcascade } from './replicad.ts';
import type { Candidate, CandidateName } from './types.ts';

export const FACTORIES: Record<CandidateName, () => Promise<Candidate>> = {
  'own-libcascade': createOwn,
  replicad: createReplicad,
  'replicad-libcascade': createReplicadOnLibcascade,
  'occt-wasm': createOcctWasm,
  brepjs: createBrepjs,
};

export const CANDIDATES = Object.keys(FACTORIES) as CandidateName[];
