import * as mediasoup from 'mediasoup';
import type { Worker } from 'mediasoup/types';
import { env } from '../config/env.js';
import { workerSettings } from '../config/mediasoup.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sfu');

/**
 * Pool of mediasoup Workers — one per CPU core (capped by MEDIASOUP_WORKERS).
 * Routers are assigned round-robin so load spreads across cores.
 */
class WorkerPool {
  private workers: Worker[] = [];
  private nextIndex = 0;
  private starting: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.workers.length > 0) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const count = Math.max(1, env.MEDIASOUP_WORKERS);
      for (let i = 0; i < count; i++) {
        const worker = await mediasoup.createWorker(workerSettings);

        worker.on('died', (error) => {
          log.error(`Worker ${worker.pid} died — exiting in 2s`, error);
          setTimeout(() => process.exit(1), 2000);
        });

        this.workers.push(worker);
        log.info(`Worker ${i + 1}/${count} started (pid ${worker.pid})`);
      }
    })();

    return this.starting;
  }

  getNext(): Worker {
    if (this.workers.length === 0) {
      throw new Error('mediasoup workers not initialised');
    }
    const worker = this.workers[this.nextIndex % this.workers.length]!;
    this.nextIndex += 1;
    return worker;
  }

  get size(): number {
    return this.workers.length;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    this.workers = [];
  }
}

export const workerPool = new WorkerPool();
