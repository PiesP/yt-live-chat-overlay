# Product composition and consumer contracts

Follow the [portfolio composition policy](https://github.com/PiesP/.github/blob/master/MAINTENANCE_POLICY.md#composition-and-behavioral-contracts).
Product orchestration shares behavior through owned collaborators and narrow
contracts at real seams, rather than inheriting implementation or mutable state
from project-defined bases. Ordinary classes, functions, closures, immutable
records, discriminated unions and TypeScript interface extension or
implementation remain available. No interface is needed for a helper that has
no consumer boundary.

`RuntimeManager` constructs the chat source for each session from the resolved
bootstrap result. The source's immutable `mode` selects live ingress or replay
timeline capabilities. It seeds a ready bootstrap once before starting the
source, owns stopping and replacement, and retains the source for health,
visibility and video-pause operations. Live fetch/DOM callbacks borrow only
message ingress. Replay callbacks and due-message draining belong to the replay
source and remain guarded by session and seek generations. The source contracts
in `src/chat/source-contracts.ts` describe these operations without exposing
the source implementation base.

`RuntimeManager` also constructs and destroys the renderer, while
`StandbyController` borrows only `setStandbyStatus`. The consumed renderer
operations are declared in `src/renderer/renderer-contracts.ts`; they do not
expose protected rendering state. Shared queue helpers call the pure
`getMessagePriority` function. Source, renderer, worker, listener, timer and
Backlog cleanup stays with the owners described by
[chat request lifetime](chat-request-lifetime.md) and the current implementation.

The following product implementation-inheritance edges are temporary and have
separate removal owners:

| Exact edge                                                                    | Why it remains in this stage                                                     | Removal condition                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LiveChatSource extends ChatSource` and `ReplayChatSource extends ChatSource` | Session bootstrap, pause, polling and delivery state still live in the base.     | [#430](https://github.com/PiesP/yt-live-chat-overlay/issues/430) replaces both with composed session and live/replay drivers, including cancellation and due-only delivery checks. |
| `CanvasRenderer extends RendererBase`                                         | Shared pause, queue and lifecycle state still lives in the base.                 | [#431](https://github.com/PiesP/yt-live-chat-overlay/issues/431) composes renderer state and migrates the shape-bound Windows observer with Main/Worker checks.                    |
| `ChatResponseTooLargeError extends ResponseTooLargeError`                     | Consumers still rely on the parent error class for response-size categorization. | [#432](https://github.com/PiesP/yt-live-chat-overlay/issues/432) removes the product-defined error edge and verifies every category check.                                         |

The direct native `Error` subclasses `LiveChatProtocolError`,
`YoutubeInnertubeRequestError`, `ResponseTooLargeError`, and
`ImageResponseTooLargeError` represent narrow request/media boundary failures.
Their internal retry, cancellation and recovery policies stay in the owning
modules. The temporary error-to-error edge above is not covered by that
exception. Generated/vendor and developer test/tooling inheritance are outside
this product migration. This architecture rule does not introduce a DI
container, common runtime or renderer framework, or another dependency.
