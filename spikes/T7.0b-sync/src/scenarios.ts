// The scenarios of the write-up. Times are virtual milliseconds. Restores (replaceDocument)
// rewind everyone's recent work, so they get scenarios of their own and are off elsewhere.

import type { Scenario } from './sim.ts';

const base = {
  loss: 0,
  remap: true,
  rederiveReplace: true,
  guardCounters: true,
  guardCreated: true,
  generator: { weights: { replaceDocument: 0 } },
} as const;

/** Assemblies, mates, configurations and CAM ten times as often as the default mix. */
const SCOPES = {
  replaceDocument: 0,
  addPart: 2,
  duplicatePart: 2,
  addAssembly: 2,
  addInstance: 6,
  addMate: 8,
  configParameter: 3,
  configRow: 3,
  camTool: 2,
  camSetup: 3,
  camOperation: 8,
};

const RESTORES = { replaceDocument: 10 };

export const SCENARIOS: Scenario[] = [
  // Two devices of one user, edits far apart compared with the latency.
  { ...base, name: 'two-calm', clients: 2, commandsPerClient: 100, think: 2000, latency: 50 },
  // Two clients editing as fast as the network turns round.
  { ...base, name: 'two-busy', clients: 2, commandsPerClient: 100, think: 100, latency: 100 },
  // Five clients, edits faster than the round trip: many concurrent commands.
  { ...base, name: 'five-busy', clients: 5, commandsPerClient: 60, think: 100, latency: 150 },
  // The same with each client's submits on one ordered channel (a WebSocket, or HTTP/2 with
  // requests sent in order): no reordering of one client's entries.
  {
    ...base,
    name: 'five-busy-fifo',
    clients: 5,
    commandsPerClient: 60,
    think: 100,
    latency: 150,
    fifo: true,
  },
  // The same without setRollback: the rollback bar is shared document state, and an add goes to
  // the bar, so another client's bar move makes adds land before what they reference.
  {
    ...base,
    name: 'five-busy-norollback',
    clients: 5,
    commandsPerClient: 60,
    think: 100,
    latency: 150,
    generator: { weights: { replaceDocument: 0, rollback: 0 } },
  },
  // The same with assemblies, mates, configurations and CAM weighted up.
  {
    ...base,
    name: 'five-scopes',
    clients: 5,
    commandsPerClient: 60,
    think: 100,
    latency: 150,
    generator: { weights: SCOPES },
  },
  // Three clients, 15 % of submits and of verdicts lost, retried after a timeout.
  {
    ...base,
    name: 'three-lossy',
    clients: 3,
    commandsPerClient: 80,
    think: 150,
    latency: 100,
    loss: 0.15,
  },
  // Client 1 offline for a long stretch while the others keep editing (a queue of ~100).
  {
    ...base,
    name: 'offline',
    clients: 3,
    commandsPerClient: 120,
    think: 200,
    latency: 80,
    offline: { from: 2000, to: 22000 },
  },
  // replaceDocument (a history restore) at weight 10, with the counter guard on the server and
  // restores rebased as their intent on the client, and without both (the naive case).
  {
    ...base,
    name: 'restores',
    clients: 3,
    commandsPerClient: 80,
    think: 150,
    latency: 150,
    generator: { weights: RESTORES },
  },
  {
    ...base,
    name: 'restores-naive',
    clients: 3,
    commandsPerClient: 80,
    think: 150,
    latency: 150,
    generator: { weights: RESTORES },
    rederiveReplace: false,
    guardCounters: false,
    ablation: true,
  },
  // Ablation: the server does not check the entry's created ids against its counters.
  {
    ...base,
    name: 'five-busy-nocreated',
    clients: 5,
    commandsPerClient: 60,
    think: 100,
    latency: 150,
    guardCreated: false,
    ablation: true,
  },
  // Ablation: no remap; an id collision drops the command.
  {
    ...base,
    name: 'five-busy-noremap',
    clients: 5,
    commandsPerClient: 60,
    think: 100,
    latency: 150,
    remap: false,
    ablation: true,
  },
];
