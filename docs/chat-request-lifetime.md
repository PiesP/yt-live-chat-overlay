# Chat request lifetime

The request module preserves the initiating abort reason. A request deadline is
a source failure; stopping a session or replacing a replay seek is cancellation.
The source modules own that distinction, not the shared core classifier.

| Owner                                                                  | Admission and outcome                                                                                                                                                | Retirement and next work                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatSession` in `src/chat/source-base.ts`                             | Owns session/poll cancellation, bootstrap, pause reasons, activity, and bounded delivery state. Stop aborts the session and clears delivery.                         | `PollLoopManager` rejects stale loop completion. The delivery generation rejects late bootstrap and payload results; a new session consumes factory preseed only once.                                                                            |
| `LiveChatDriver` in `src/chat/source-live.ts`                           | Owns live continuation, density, and failure accounting. It combines the session signal with its request-local deadline.                                           | Timeout reaches `runLiveLoop` failure accounting; a healthy payload resets failures. The existing failure limit stops the loop for managed recovery.                                                                                            |
| `ReplayChatDriver` in `src/chat/source-replay.ts`                       | Owns serialized requests, seek controllers, buffer, and independent network/display schedulers. It combines caller, local deadline, and active-request signals.    | `finally` releases the queue and active controller. Seek/session generations reject stale results. Timeouts follow replay failure/backoff policy; seek cancellation does not count as failure. Display continues independently of network work. |
| `fetchChatEndpoint` in `src/chat/youtube/api.ts`                       | Retries transport `TypeError` and HTTP 429/503/504 within the source's one request budget. Checks the reason before every attempt and passes it through retry waits. | Fetch/body failure propagates unchanged; retry timers/listeners are owned by core `sleep`. No new attempt starts after the signal expires.                                                                                                      |
| `RuntimeManager` in `src/app/runtime-manager.ts`                       | Observes source health and owns managed session recovery.                                                                                                            | Its watchdog remains a recovery mechanism for the existing breaker/stall conditions, not the normal path for one request timeout.                                                                                                               |

The first abort to reach `AbortSignal.any` determines its immutable reason. A
later parent stop cannot relabel an already-settled timeout, and a later timeout
cannot relabel a completed parent cancellation. Diagnostics require the caught
error to be the deadline reason, rather than inferring causality from a signal
that became aborted later. Session and seek delivery guards still suppress stale
work independently of error classification.

The [DOM abort contract](https://dom.spec.whatwg.org/#interface-abortsignal)
defines `reason`, `throwIfAborted`, timeout and first-signal composition; the
[Fetch abort algorithm](https://fetch.spec.whatwg.org/#abort-fetch) rejects fetch
and its body with that reason. The pinned core `throwIfAborted` and `sleep`
already retain native `TimeoutError` reasons. Keep its strict `isAbortError`
policy and consumer runtime gitlink unchanged for a product retry correction.
Arbitrary non-DOMException sleep reasons retain core's documented conversion
policy; this contract does not add a broader shared cancellation type.

Keep current request budgets, retry delays/statuses and source limits in their
source authorities. Tool versions belong to `.node-version`, `package.json` and
the lockfile. Core source identity belongs to the `packages/core` gitlink;
automation Action pins are independent.

Verification owners:

- `test/browser/core/chat-endpoint-retry.browser.test.ts` uses real core helpers
  with controlled fetch/clocks for deadline phases, retry limits and cancellation.
- `test/browser/source-live.browser.test.ts` verifies failure accounting,
  continued healthy polling, breaker behavior and session retirement.
- `test/browser/source-replay.browser.test.ts` verifies queue retirement,
  replay failure/recovery, seek generations and buffered delivery.
- Runtime watchdog tests cover managed recovery; emitted/installed fixture and
  real YouTube observations establish only the distribution/compatibility paths
  they actually exercise. Browser Mode alone does not establish installation.
