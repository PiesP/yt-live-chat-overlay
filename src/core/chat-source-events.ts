/**
 * Type-safe event bus for decoupled communication between chat components.
 *
 * Events:
 *   'messages'     — ChatMessage[] received from the API
 *   'error'        — Error occurred during fetching
 *   'stall'        — No messages received within the activity timeout
 *   'offset-jump'  — Playback position jumped (seek detected)
 */
export type ChatSourceEventMap = {
  messages: ChatMessageBatchEvent;
  error: ChatSourceErrorEvent;
  stall: ChatSourceStallEvent;
  'offset-jump': ChatSourceOffsetJumpEvent;
};

export interface ChatMessageBatchEvent {
  messages: unknown[];
  isInitialSeed: boolean;
}

export interface ChatSourceErrorEvent {
  error: Error;
  retryable: boolean;
}

export interface ChatSourceStallEvent {
  lastActivityTime: number;
}

export interface ChatSourceOffsetJumpEvent {
  fromOffsetMs: number;
  toOffsetMs: number;
}

type Listener<T> = (payload: T) => void;

export class ChatSourceEventBus {
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();

  on<K extends keyof ChatSourceEventMap>(
    event: K,
    listener: Listener<ChatSourceEventMap[K]>
  ): () => void {
    const key = event as string;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as Listener<unknown>);
    return () => {
      set?.delete(listener as Listener<unknown>);
    };
  }

  emit<K extends keyof ChatSourceEventMap>(event: K, payload: ChatSourceEventMap[K]): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<ChatSourceEventMap[K]>)(payload);
      } catch (_err) {
        // Prevent one listener error from breaking others
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
