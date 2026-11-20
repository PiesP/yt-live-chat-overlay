# Chat request lifetime

The request module preserves the initiating abort reason. A request deadline is
a source failure; stopping a session or replacing a replay seek is cancellation.
The source modules own that distinction, not the shared core classifier.

| Owner                                             | Admission and outcome                                                                                                                                                | Retirement and next work                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChatSession` in `src/chat/source-base.ts`        | Owns session/poll cancellation, bootstrap, pause reasons, activity, and bounded delivery state. Stop aborts the session and clears delivery.                         | `PollLoopManager` rejects stale loop completion. The delivery generation rejects late bootstrap and payload results; a new session consumes factory preseed only once.                                                                           |
| `LiveChatDriver` in `src/chat/source-live.ts`     | Owns live continuation, density, and failure accounting. It combines the session signal with its request-local deadline.                                             | Timeout reaches `runLiveLoop` failure accounting; a healthy payload resets failures. The existing failure limit stops the loop for managed recovery.                                                                                             |
| `ReplayChatDriver` in `src/chat/source-replay.ts` | Owns serialized requests, seek controllers, buffer, and independent network/display schedulers. It combines caller, local deadline, and active-request signals.      | Settlement releases the request's queue reservation. Seek/session generations reject stale results. Timeouts follow replay failure/backoff policy. Seek cancellation does not count as failure. Display continues independently of network work. |
| `fetchChatEndpoint` in `src/chat/youtube/api.ts`  | Retries transport `TypeError` and HTTP 429/503/504 within the source's one request budget. Checks the reason before every attempt and passes it through retry waits. | Fetch/body failure propagates unchanged; retry timers/listeners are owned by core `sleep`. No new attempt starts after the signal expires.                                                                                                       |
| `RuntimeManager` in `src/app/runtime-manager.ts`  | Observes source health and owns managed session recovery.                                                                                                            | Its watchdog remains a recovery mechanism for the existing breaker/stall conditions, not the normal path for one request timeout.                                                                                                                |

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

## Bounded replay admission check

A seek or session stop can abort an active replay request while its transport
promise remains pending. Reset may clear the active controller reference.
The serialized successor still waits for the predecessor's queue reservation
to be released in `requestReplayPayload`. Its deadline starts after it reaches
the queue head and passes the caller's abort check. The delivery and seek
generations are checked before the buffer or callback can observe a result.

Run the independent model and the production path tests with the repository's
pinned Vite+ and Vitest versions.

```sh
vp test run --project=unit test/unit/chat/replay-admission-model.test.ts test/unit/source-base-refresh.test.ts
vp test run --project=browser test/browser/source-replay.browser.test.ts
```

The model starts with one active operation. It allows one seek or one
stop/start pair and one successor. The old deadline may fire once while its
transport is pending. Transport can fulfill, reject independently, or reject
with the first abort reason. Each request must settle for a trace to complete.
A settlement event includes the resulting microtasks and a display
opportunity for due messages. Retry schedules, repeated replacements, and
network or display progress without settlement are outside the model.

| Replacement | Explored prefixes | Complete traces | Maximum events |
| ----------- | ----------------: | --------------: | -------------: |
| Seek        |                66 |              28 |              5 |
| Session     |               466 |             194 |              7 |

For every prefix, the checker derives expected ownership, first abort,
settlement outcome and visible messages from the event history. It also checks
that old-loop completion leaves the replacement polling observer alive. The
browser fixtures exercise production `ReplayChatSource.start`, `stop` and the
video's `seeked` event with deferred fetch responses. They observe the signal
reason, fetch admission order, timeout diagnostics and message delivery.
The polling fixture drives `ChatSession.start` with a controlled driver.

Both projects run under `vp run test:cov` in `pr-gate/unit`. Browser Mode
exercises a controlled Chromium page. Installed-browser, native PiP, and
live YouTube evidence have separate acceptance conditions.

Worker batch receipts publish capacity. A matching clear acknowledgement
confirms the remote clear fence. Stats or a recovery snapshot provide distinct
evidence about processing and recoverability. A reused message ID before the
clear acknowledgement exposed a separate fallback accounting gap. See
[PiesP/yt-live-chat-overlay#473](https://github.com/PiesP/yt-live-chat-overlay/issues/473).
