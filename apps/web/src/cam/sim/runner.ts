// Drives the CAM worker's simulation for the preview (M5 plan, T5.3c): one request in flight at a
// time, and only the newest move wanted after it, so a playback at 60 frames a second never queues
// work the worker would throw away. The program goes to the worker once per program (its buffers
// are transferred, so it is packed afresh for each send); later requests carry only the move
// number, and a `needs-program` reply (the worker was restarted, or holds another program) sends
// it again.

import type { CamSimFrame, CamSimProgram, CamSimulateProgramRequest } from '@manufakture/cam';
import type { CamSimulateProgramResult } from '@manufakture/cam/client';

/** What the runner needs of `CamClient`. */
export interface SimulationClient {
  simulateProgram(
    request: Omit<CamSimulateProgramRequest, 'generation'>,
  ): Promise<CamSimulateProgramResult | null>;
}

export interface SimulationRunnerEvents {
  /** A frame of the current program. */
  onFrame(frame: CamSimFrame): void;
  /** The worker could not simulate the program. */
  onError(message: string): void;
}

let ids = 0;

export class SimulationRunner {
  private programId: string | null = null;
  private build: (() => CamSimProgram) | null = null;
  private sent = false;
  private wanted: number | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly client: SimulationClient,
    private readonly events: SimulationRunnerEvents,
  ) {}

  /** A new program, made by `build` when it has to be sent; its frames replace the old one's. */
  setProgram(build: () => CamSimProgram): void {
    this.programId = `sim-${++ids}`;
    this.build = build;
    this.sent = false;
  }

  /** Simulate up to `upTo` moves done (the newest call wins). */
  request(upTo: number): void {
    if (this.stopped || !this.build) return;
    this.wanted = upTo;
    if (!this.busy) void this.pump();
  }

  /** True while a request is in flight. */
  get running(): boolean {
    return this.busy;
  }

  /** Stop: replies still to come are dropped. */
  stop(): void {
    this.stopped = true;
    this.wanted = null;
  }

  private async pump(): Promise<void> {
    this.busy = true;
    try {
      let retried = false;
      while (this.wanted !== null && !this.stopped && this.build && this.programId) {
        const upTo = this.wanted;
        this.wanted = null;
        const programId = this.programId;
        const program = this.sent ? undefined : this.build();
        this.sent = true;
        let reply: CamSimulateProgramResult | null;
        try {
          reply = await this.client.simulateProgram({
            programId,
            upTo,
            ...(program ? { program } : {}),
          });
        } catch (e) {
          this.sent = false;
          if (!this.stopped) this.events.onError(e instanceof Error ? e.message : String(e));
          continue;
        }
        if (this.stopped || reply === null) continue;
        if (programId !== this.programId) {
          // A newer program arrived meanwhile: its own request follows.
          this.wanted ??= upTo;
          continue;
        }
        if (reply.status === 'needs-program') {
          this.sent = false;
          if (!retried) {
            retried = true;
            this.wanted ??= upTo;
          }
          continue;
        }
        if (reply.status === 'failed') {
          this.sent = false;
          this.events.onError(reply.message);
          continue;
        }
        retried = false;
        this.events.onFrame(reply.frame);
      }
    } finally {
      this.busy = false;
    }
  }
}
