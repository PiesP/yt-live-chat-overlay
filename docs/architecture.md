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
session state. Each ordinary live/replay source composes a `ChatSession`, which
owns bootstrap, cancellation, pause, activity, delivery and deduplication. Private
live/replay drivers own polling or timeline protocol state. They borrow the
role-specific `LiveChatSessionOperations` or `ReplayChatSessionOperations`
interface from the session collaborator, without a mutable context or callback
table. The session owns managed poll-loop launch and raw delivery invalidation;
replay can request only the semantic seek transition. Independent replay network
and display scheduling stays with the replay driver.

`RuntimeManager` also constructs and destroys the renderer, while
`StandbyController` borrows only `setStandbyStatus`. The consumed renderer
operations are declared in `src/renderer/renderer-contracts.ts`; they do not
expose protected rendering state. Shared queue helpers call the pure
`getMessagePriority` function. Source, renderer, worker, listener, timer and
Backlog cleanup stays with the owners described by
[chat request lifetime](chat-request-lifetime.md) and the current implementation.

The following product implementation-inheritance edges are temporary and have
separate removal owners:

| Exact edge                            | Why it remains in this stage                                     | Removal condition                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanvasRenderer extends RendererBase` | Shared pause, queue and lifecycle state still lives in the base. | [#431](https://github.com/PiesP/yt-live-chat-overlay/issues/431) composes renderer state and migrates the shape-bound Windows observer with Main/Worker checks. |

The direct native `Error` subclasses `LiveChatProtocolError`,
`YoutubeInnertubeRequestError`, `ResponseTooLargeError`, `ChatResponseTooLargeError`, and
`ImageResponseTooLargeError` represent narrow request/media boundary failures.
Their internal retry, cancellation and recovery policies stay in the owning
modules. Chat and other bounded-response failures share the checked
`isResponseSizeError` category and readonly detail contract in
`src/chat/youtube/response-text.ts`; each keeps its own native error identity,
name/message and fields. A parent `instanceof ResponseTooLargeError` check only
identifies that concrete variant; use the category guard for both response-size
variants. Generated/vendor and developer test/tooling inheritance are outside
this product migration. This architecture rule does not introduce a DI
container, common runtime or renderer framework, or another dependency.
