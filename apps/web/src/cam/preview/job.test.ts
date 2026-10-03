// The preview's program: the generation linked into the job (with its tool changes and linking
// moves), statistics per operation and for the job, operations that failed or are suppressed
// left out, and the unlinked fallback when the job refuses an operation.

import { JOB_LINK_OP, packToolpath, toolpathStats, type Toolpath } from '@manufakture/cam';
import { describe, expect, it } from 'vitest';
import { previewJob } from './job';
import { circle, fixtureGeneration, rectangle } from './preview.test-fixture';

const stats = (tp: Toolpath) => {
  const r = toolpathStats(tp, { rapidRate: 5000 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('previewJob', () => {
  it('links both operations into the job, with statistics for each and for the job', () => {
    const job = previewJob(fixtureGeneration());
    expect(job.message).toBeNull();
    expect(job.operations.map((o) => [o.id, o.name, o.included])).toEqual([
      ['profile#1', 'Outline', true],
      ['pocket#1', 'Bore', true],
    ]);
    expect(job.operations[0]!.stats).toEqual(stats(rectangle));
    expect(job.operations[1]!.stats).toEqual(stats(circle));
    const tools = job.toolpath.entries.filter((e) => e.kind === 'toolChange').map((e) => e.tool);
    expect(tools).toEqual(['tool#1', 'tool#2']);
    expect(job.toolpath.entries.some((e) => 'op' in e && e.op === JOB_LINK_OP)).toBe(true);
    // The job cuts what the operations cut; its time adds links, rapids and spindle dwells.
    expect(job.stats!.cutLength).toBeCloseTo(
      stats(rectangle).cutLength + stats(circle).cutLength,
      9,
    );
    expect(job.stats!.estimate.totalMinutes).toBeGreaterThan(
      stats(rectangle).estimate.totalMinutes + stats(circle).estimate.totalMinutes,
    );
    expect(job.tools.get('tool#2')?.kind).toBe('vbit');
  });

  it('leaves out a failed operation and a suppressed one', () => {
    const failed = previewJob(fixtureGeneration({ failed: true }));
    expect(failed.message).toBeNull();
    expect(failed.operations.map((o) => o.included)).toEqual([true, false]);
    expect(failed.operations[1]!.stats).toBeNull();
    expect(failed.toolpath.entries.some((e) => 'op' in e && e.op === 'pocket#1')).toBe(false);

    const suppressed = previewJob(fixtureGeneration(), new Set(['profile#1']));
    expect(suppressed.operations.map((o) => o.included)).toEqual([false, true]);
    // A suppressed operation still has its own statistics, but the job does not cut it.
    expect(suppressed.operations[0]!.stats).not.toBeNull();
    expect(suppressed.stats!.cutLength).toBeCloseTo(stats(circle).cutLength, 9);
  });

  it('says so when nothing is left', () => {
    const job = previewJob(fixtureGeneration(), new Set(['profile#1', 'pocket#1']));
    expect(job.message).toBe('No generated operation to show.');
    expect(job.toolpath.entries).toEqual([]);
  });

  it('plays the operations unlinked when the job refuses one', () => {
    // A toolpath starting below the stock top cannot be linked: the job would rapid into it.
    const data = fixtureGeneration();
    const low: Toolpath = { ...circle, start: [35, 20, -5] };
    const operations = [
      data.operations[0]!,
      { ...data.operations[1]!, toolpath: packToolpath(low) },
    ];
    const job = previewJob({ ...data, operations });
    expect(job.message).toMatch(/^Shown unlinked: /);
    const moves = job.toolpath.entries.filter((e) => e.kind !== 'toolChange');
    expect(moves.length).toBe(rectangle.entries.length + 1 + circle.entries.length);
    expect(job.toolpath.start).toEqual(rectangle.start);
    expect(job.stats).not.toBeNull();
  });
});
