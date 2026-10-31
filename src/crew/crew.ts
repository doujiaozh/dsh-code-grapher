/**
 * Crew — parallel multi-agent analysis orchestration
 * ===================================================
 * The "crew" is N logical workers (CG_WORKERS, default 4). Each worker is a
 * long-lived consumer pulling file-batches off a shared queue; every batch
 * is one LLM call through the sliding-window RateLimiter (InkStone 50 RPM).
 *
 * The crew object below is bookkeeping the CLI surfaces in progress lines:
 *   workers=4 rpm=45 batches=17 est≈0m22s
 * It exists so `cg graph .` can report realistic ETA/throughput without
 * depending on how mapWithConcurrency is implemented.
 */
import { AppConfig } from '../config';

export interface CrewMember {
  id: number;
  state: 'idle' | 'running' | 'done';
  batchesDone: number;
}

export interface CrewSummary {
  workers: number;
  rpm: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  members: CrewMember[];
  totalBatches: number;
  estimatedSeconds: number;
}

export class ParallelCrew {
  constructor(private cfg: AppConfig) {}

  plan(totalUnits: number): CrewSummary {
    const batchSize = Math.max(1, this.cfg.batchSize);
    const totalBatches = Math.max(1, Math.ceil(totalUnits / batchSize));
    // conservative ETA: requests fit in 60s windows of `rpm` each;
    // every batch = one request (successful path)
    const fullWindows = Math.floor(totalBatches / this.cfg.rpm);
    const remainder = totalBatches % this.cfg.rpm;
    const estimatedSeconds = fullWindows * 60 + (remainder > 0 ? Math.min(45, remainder * 3) : 0);
    const members: CrewMember[] = [];
    for (let i = 0; i < this.cfg.workers; i++) {
      members.push({ id: i, state: 'idle', batchesDone: 0 });
    }
    return {
      workers: this.cfg.workers,
      rpm: this.cfg.rpm,
      createdAt: Date.now(),
      members,
      totalBatches,
      estimatedSeconds,
    };
  }

  begin(crew: CrewSummary): void {
    crew.startedAt = Date.now();
    for (const m of crew.members) m.state = 'running';
  }

  finish(crew: CrewSummary, resultsCount: number): void {
    crew.finishedAt = Date.now();
    for (const m of crew.members) m.state = 'done';
    this.lastResultsCount = resultsCount;
  }

  private lastResultsCount = 0;

  describe(crew: CrewSummary): string {
    const elapsed = crew.startedAt ? Math.round(((crew.finishedAt ?? Date.now()) - crew.startedAt) / 1000) : 0;
    return `workers=${crew.workers} rpm=${crew.rpm} est≈${formatDuration(crew.estimatedSeconds)} elapsed=${formatDuration(elapsed)} analyzed=${this.lastResultsCount}`;
  }
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}
