import { sleep, throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import type { ChatBootstrapData, ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

const log = createLogger('BootstrapResolver');

const BOOTSTRAP_MAX_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

interface ChatBootstrapResolution {
  status: ChatBootstrapResult['status'];
  bootstrap?: ChatBootstrapData;
  reason: string;
}

export class BootstrapResolver {
  async resolve(signal?: AbortSignal): Promise<ChatBootstrapResolution> {
    let lastResult: ChatBootstrapResult | null = null;

    for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
      throwIfAborted(signal);

      const result = await bootstrapChatSession(signal);
      if (result.status === 'ready') {
        return {
          status: 'ready',
          bootstrap: result.data,
          reason: 'Chat bootstrap resolved successfully',
        };
      }

      lastResult = result;
      if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
        await sleep(BOOTSTRAP_RETRY_DELAY_MS, signal);
      }
    }

    return {
      status: lastResult?.status ?? 'retryable',
      reason: lastResult?.reason ?? 'Chat bootstrap did not become available',
    };
  }

  async refresh(signal?: AbortSignal): Promise<ChatBootstrapData | null> {
    const resolution = await this.resolve(signal);

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return null;
    }

    return resolution.bootstrap;
  }

  logFailure(resolution: ChatBootstrapResolution): void {
    if (resolution.status === 'retryable') {
      log.warn(
        `Chat bootstrap was retryable after ${BOOTSTRAP_MAX_ATTEMPTS} attempts: ${resolution.reason}`
      );
      return;
    }

    log.warn('Chat source is unavailable:', resolution.reason);
  }
}
