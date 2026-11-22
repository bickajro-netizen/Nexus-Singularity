// Main-thread GraphWorker: spawns the module worker, matches requestId, guards revisions.

import type { ComputeGraphAndXpRequest, GraphAndXpResult } from './protocol';

interface Pending { resolve: (result: GraphAndXpResult) => void; reject: (err: Error) => void; timer: number }

const COMPUTE_TIMEOUT_MS = 10_000;

export class GraphWorker {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private lastProcessedRevision = 0;
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./graphWorker.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<GraphAndXpResult>) => {
      const result = event.data;
      if (!result || result.type !== 'GRAPH_AND_XP_RESULT') return;
      const entry = this.pending.get(result.requestId);
      if (!entry) return;
      this.pending.delete(result.requestId);
      window.clearTimeout(entry.timer);
      entry.resolve(result);
    };
    this.worker.onerror = (event) => {
      for (const [id, entry] of this.pending) {
        window.clearTimeout(entry.timer);
        entry.reject(new Error(`GraphWorker error: ${event.message}`));
        this.pending.delete(id);
      }
    };
  }

  compute(request: Omit<ComputeGraphAndXpRequest, 'type' | 'requestId'>): Promise<GraphAndXpResult> {
    if (this.disposed) return Promise.reject(new Error('GraphWorker disposed'));
    const requestId = crypto.randomUUID();
    const full: ComputeGraphAndXpRequest = { ...request, type: 'COMPUTE_GRAPH_AND_XP', requestId };
    return new Promise<GraphAndXpResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`GraphWorker timeout for ${requestId}`));
      }, COMPUTE_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage(full);
    });
  }

  acceptSnapshot(revision: number): boolean {
    if (revision <= this.lastProcessedRevision) return false;
    this.lastProcessedRevision = revision;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, entry] of this.pending) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error('GraphWorker disposed'));
      this.pending.delete(id);
    }
    this.worker.terminate();
  }
}
