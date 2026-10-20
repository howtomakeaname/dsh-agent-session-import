/**
 * In-memory import job registry: progress snapshots, cancellation and the
 * single-active-job policy. Jobs are transient; the durable record of an import
 * is the `ImportedState` map plus the written session log.
 */
import { randomUUID } from 'node:crypto';

/** Completed jobs retained for status reads. */
export const MAX_RETAINED_JOBS = 5;

/** Import job registry. */
export class ImportJobs {
  /**
   * @param options - retention override (tests use a smaller window).
   */
  constructor({ maxRetained = MAX_RETAINED_JOBS } = {}) {
    this.maxRetained = maxRetained;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.activeJobId = null;
    this.cancelRequested = false;
  }

  /** The job currently running, if any. */
  active() {
    return this.activeJobId === null ? null : this.jobs.get(this.activeJobId);
  }

  /** Whether a job is still running. */
  busy() {
    return this.active()?.state === 'running';
  }

  /**
   * Register a new running job and retain it in the registry.
   * @param total - number of selected conversations.
   * @param mode - import mode (`full` or `compatible`).
   * @returns the mutable job state.
   */
  create(total, mode) {
    const job = {
      jobId: `job-${randomUUID()}`,
      mode,
      state: 'running',
      total,
      completed: 0,
      current: null,
      results: [],
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    this.cancelRequested = false;
    this.prune();
    return job;
  }

  /** Drop finished jobs beyond the retention window. */
  prune() {
    if (this.jobs.size <= this.maxRetained) return;
    for (const [jobId, job] of this.jobs) {
      if (this.jobs.size <= this.maxRetained) break;
      if (job.state === 'running') continue;
      this.jobs.delete(jobId);
    }
  }

  /**
   * Settle a job and release the single-active-job slot.
   * @param job - job state returned by {@link create}.
   * @param state - final state.
   */
  finish(job, state) {
    job.state = state;
    job.finishedAt = Date.now();
    job.current = null;
    this.activeJobId = null;
    this.prune();
  }

  /**
   * Status snapshot for one job.
   * @param jobId - job id.
   * @returns snapshot, or null when unknown/evicted.
   */
  status(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (job === undefined) return null;
    return {
      jobId: job.jobId,
      state: job.state,
      total: job.total,
      completed: job.completed,
      current: job.current,
      results: job.results,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.error === undefined ? {} : { error: job.error }),
    };
  }

  /**
   * Request cancellation of the running job.
   * @param jobId - job id.
   * @returns `{ cancelled, state }`, or null when unknown.
   */
  cancel(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (job === undefined) return null;
    if (job.state !== 'running') return { cancelled: false, state: job.state };
    if (job.jobId !== this.activeJobId) return { cancelled: false, state: job.state };
    this.cancelRequested = true;
    return { cancelled: true, state: 'cancelling' };
  }

  /** Drop every retained job (plugin disposal). */
  clear() {
    this.jobs.clear();
    this.activeJobId = null;
    this.cancelRequested = false;
  }
}
