import { isAbortError } from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('PollLoop');

export class PollLoopManager {
  private generation = 0;
  private alive = false;

  /** Launch a polling loop runner. */
  launch(runner: (signal?: AbortSignal) => Promise<void>, signal?: AbortSignal): void {
    const generation = ++this.generation;
    this.alive = true;

    void (async () => {
      try {
        await runner(signal);
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          log.warn('Polling loop stopped unexpectedly:', error);
        }
      } finally {
        if (generation === this.generation) {
          this.alive = false;
        }
      }
    })();
  }

  stop(): void {
    this.generation += 1;
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive;
  }
}
