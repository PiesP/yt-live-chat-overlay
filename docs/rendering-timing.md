# Rendering timing contract

## Regular-message content

The parser keeps ordinary comments compact: `text` and `content` are the visible
projection, limited to 80 code points including an ellipsis. Truncation stops
before a whole grapheme that would exceed the budget. When the accepted body is
longer, `canonicalText` and `canonicalContent` retain its normalized, bounded
source; short messages omit these fields. Rich emoji fallback text contributes
to `canonicalText`, while translation reads only text segments from
`canonicalContent` and never sends emoji descriptions. Main and Worker draw and
measure only `text`/`content`; both supply `canonicalText ?? text` to accessible
alternatives. Only bounded `canonicalText` crosses to the Worker. Replacement
uses the existing message ID, and display assets come only from visible content.
The existing 4096-code-point field and aggregate limits, 512-segment limit, and
translation request budgets still apply to accepted input. Paid and membership
bodies retain their existing full source and line-limited display behavior.

The aggregate budget counts the longest body representation once, alongside the
existing author and metadata fields. It does not grant an additional body budget
for canonical fields. If grapheme segmentation is unavailable, truncation treats
each text segment as indivisible and uses an ellipsis when it cannot fit. This
can retain less text, while preserving the compact limit and whole characters.

## Paid cards and preview

`superChatLayout` selects `stacked` or `wide`. Both existing and new settings
default to `stacked`; load, import, export, preview, reset and synchronization
retain the selected value. Wide cards allocate the original localized amount
before flexible author text. When the metadata cannot share a row, the amount
uses a separate row. Author shortening respects graphemes. An exceptionally long
amount fits its bounded badge through horizontal text fitting, which can reduce
its apparent width; this is not a reading-time guarantee.

Estimation, Main, Worker and the production settings preview use the same paid
card plan and prepared paragraph rows. Original and dual translation share the
configured total body-line budget. With a one-line budget, the original keeps
that line; a dual translation has no additional visual row. Accessible text
alternatives retain the bounded original and selected translation, as described
below, and can be more complete than the Canvas projection. Replace mode uses
the translation as the body. Amount-only and empty-body cases add no body gap.

Sticker rows retain a fixed bounded reservation while images load. Loaded images
preserve their aspect ratio; pending or failed images use the same visible alt
placeholder in both renderers. Keeping the reservation avoids an asynchronous
height change. Ordinary member-authored comments keep the regular layout;
membership events keep their event card.

Paid body, amount, metadata and translation share the card foreground. Automatic
black/white selection compares RGB contrast on the selected card color; opacity
and arbitrary video backgrounds still affect the final composite. Membership
uses a shared border treatment, static under effective reduced motion. The old
Main-only blurred glow is retired so decoration follows the same availability
and content opacity in both renderers. Appearance preview includes paid,
membership, author, emoji, translation and narrow-card samples using actual
settings and the production drawing path. Text Color also controls ordinary
body text, matching its label.

## Motion and geometry

Canvas and OffscreenCanvas Worker rendering use the shared motion planner in
`src/renderer/layout/message-schedule.ts`. Each candidate's effective mode,
start, geometry, actual velocity, viewport entry, and visible interval are
checked before that same plan is committed. Future reservations participate in
collision checks. Ordinary scrolling comments can share a lane when their
rectangles maintain the configured gap throughout their common visible interval.
System reduced motion and the existing override resolve stationary occupancy
before allocation; the saved display mode does not change.

Configured velocity sets nominal scrolling duration. The existing minimum and
maximum duration limits apply next, followed by the moderator/owner duration
multiplier. Safety uses total travel divided by this final duration. Equal speed
tiers can therefore have different actual velocities.

Backlog velocity is `max(1, baseSpeed * max(1, backlogMultiplier))` in both
renderers, without additional burst acceleration. This retains the existing
Canvas readability policy while correcting faster Worker Backlog messages.
The Worker may serialize a burst multiplier for ordinary messages, but Backlog
ignores it, including while pending. Speed settings establish the nominal plan
at placement and on deliberate motion-policy changes. Geometry reflow can adjust
actual velocity to preserve the existing position and expiry, as described
below. A committed plan keeps its velocity and reservation between reflows;
pause and recovery preserve its elapsed progress and future entry.

Fade-in and age dimming retain the first-appearance clock across reflow.
Fade-out uses the current committed motion's remaining time, so a shorter plan
does not accidentally become transparent while it is still alive. Pause offsets
apply to both clocks; geometry changes do not restart fade-in.

Accessible alternatives follow completed drawing in the current frame. A comment
must have entered its committed interval, intersect the viewport, and have
positive quantized body opacity; hidden, future, expired and fully transparent
comments are excluded. Pause uses the frozen logical time. Dual translation
exposes the bounded canonical original and selected translation; replace mode
exposes the translation, falling back to the original when unavailable. This is
a rendering contract, not a screen-reader compatibility qualification.

`totalRendered` retains its legacy allocation meaning. `totalPresented` counts
the first completed eligible draw of a placement. Pause, reflow, same-ID updates
and validated recovery preserve that attribution. Deliberate seek replay creates
a new placement. When Worker recovery has only IDs or times out without a fresh
snapshot, a later draw increments `totalPresentationUnknown` instead of guessing
whether it was already counted. The confirmed presentation total is therefore a
lower bound after uncertain recovery. Both counters reset with the existing
session metrics; they do not retain an unbounded history of message IDs.

Vertical geometry uses the saved `fontSize` in logical pixels for measurement,
regular drawing, prewarming, lane creation and reflow in both renderers.
Resizing/fullscreen changes capacity and paid-card width without resizing text.
Legacy responsive sizing preferences remain stored but do not scale the lanes.
Transparent regular comments keep outline/antialiasing and photo overflow without
decorative vertical card padding; visible backgrounds retain their card insets.
Top-baseline font envelopes and cached actual-content bounds account for CJK,
fallback fonts, combining marks and emoji. Outlined bitmaps preserve above-origin
ink and its draw origin. Ordinary scrolling remains single-line. Fixed modes,
including effective reduced motion, use bounded prepared rows. Measurement and
drawing share wrapping and paragraph bidi; actual image-emoji and fallback ink,
horizontal bearings and outline insets contribute to the reserved rectangle.
The Worker measures with its own drawing context before admission or updates,
and the settings preview supplies its actual context to the same estimator.

`laneSpacing` is additional logical-pixel separation outside each content
rectangle. Its existing 0–20 range, 1px step and default zero remain unchanged.
The ordinary row pitch is its complete compact height plus this gap. Density
factors 1, 0.75 and 0.5 select 1, 2 and 4 subdivisions of that pitch; an ordinary
row reserves all its subdivisions, so finer grids do not claim more ordinary
capacity or increase its pitch. Genuinely taller author, translation and paid
content reserves `ceil((height + gap) / gridHeight)` slots. Its remaining discrete
rounding space is centered around content, excluding the user gap. The final
partial grid block can reduce that centering inset to keep real content inside
the safe zone; it still reserves every required slot. Reservations
and reflow use the same rule, including mixed-height neighbors that need vertical
separation. Spread still spans the full safe zone and may
leave unused rows or future reservations. The settings preview paints two
rows with the shared estimate, reservation and drawing code.

Admission checks the candidate's actual Y and height against both safe-zone
edges. A smaller candidate may fit a partial block that cannot contain a normal
row. Transient safe-zone capacity failures stay in the bounded pending queue;
geometry, settings or replacement invalidate their deferral without a retry
loop. Whole-viewport oversize remains a separate disposition. Zero usable
capacity does not permanently discard an otherwise fitting row.

## Burst rates and Backlog selection

Burst levels use messages per actual elapsed second over the bounded sample
window, including delayed timer ticks. Default and saved thresholds retain their
numeric values (5/15/30 by default); no migration or automatic retuning applies.
The corrected units can select a higher burst level than the former per-sample
comparison. An arrival batch sharing one timestamp does not supply an
inter-arrival interval for the separate speed EMA. Backlog retains its exclusion
from additional burst acceleration.

Backlog sampling covers message rank after timestamp ordering, rather than equal
time buckets, within the controller's existing bounded candidate set. When the
ordinary budget permits, it reserves the oldest and latest ordinary candidates
before favoring substantial text and spreading remaining picks across each
tier. A single slot favors the latest. Paid and membership candidates remain
protected outside that ordinary sampling budget. The short-text heuristic
accepts CJK and pictographic emoji reactions without claiming to infer meaning.
Full mode covers the full admitted time range; sampling and capacity limits
still apply, so it does not promise to show every historical message.

A maximum Backlog rate of zero holds the bounded pending queue without a timer
or emission; a positive maximum resumes it. The runtime maximum wins a conflict
with the minimum, while saved explicit values remain intact through load,
import, preview and save. The maximum caps the randomized scheduling target's
mean rate, not every instantaneous inter-message interval. Existing defaults,
resource bounds and replay due-time rules remain unchanged.

## Entry and queue policy

Live entry pacing groups messages by queue priority and speed tier. Backlog
messages retain their existing lower priority. Temporal delay and horizontal
offset share the adaptive entry window. A group's previous geometric entry is
retained across frames when it fits that window; an earlier long lane wait can
be overtaken rather than blocking an unrelated free lane. Replay bypasses these
optional effects. Lane availability and collision safety can still delay entry.
Geometric entry means crossing the viewport edge, independently of fade opacity.

Drain attempts include failures in both the count and elapsed-work limits.
The Main pending priority queue clears each consumed head reference immediately.
Empty buckets retain zero slots; otherwise prefix reclamation at half-consumed
storage keeps fewer than twice the live slots. Batch removal compacts during
its existing linear scan, and trimming applies the same reclamation invariant.
This bounds retained queue storage independently of cumulative traffic while
preserving FIFO ordering, priority displacement and drop accounting.

Higher priority groups are normally examined first. After two higher-priority
successful placements, the next eligible drain gives ordinary priority-zero
content the first opportunity. A failed attempt does not spend that success
credit. This is a start-of-drain preference, not a fixed throughput ratio or a
latency guarantee across arbitrary geometry and simultaneous vacancies. Backlog
ordinary messages have priority -50 and remain outside this share. Priority-zero
due replay content participates after source-time eligibility; future replay
content is not admitted early.

Each group's identity cursor rotates past repeated failures. A saved
time-budget continuation takes precedence over the success share, so a costly
ordinary failure cannot prevent the next group from receiving an attempt in the
following drain. Successful placements and permanently oversized messages are
removed; transient failures remain in the existing bounded queue. The anti-block
gate retains its priority bypass, replay policy, and forced retry deadline.

At full pending capacity, equal-priority ordinary arrivals replace the oldest
ordinary entry. Higher-priority arrivals preserve the last already-admitted
ordinary entry; other priority displacement and paid/event FIFO rules remain.
Worker ingress reuses its existing bounded deferred buffer and gives ordinary
dispatch a turn after two higher-priority dispatches when capacity permits.
If that ordinary entry cannot displace current Worker work, another eligible
higher-priority entry can proceed. Dispatch is distinct from successful placement
and actual presentation. Recovery's temporary ingress buffer retains FIFO and
same-ID coalescing to preserve snapshot and replacement ownership.
When the full Manager buffer admits a new ID by evicting an older entry, it
appends the newcomer after the surviving entries of equal priority. A known
same-ID replacement keeps its existing slot.

There is no waiting-age TTL. Queue sizes bound retained count, not waiting time;
parser timestamps are not an eligible-running-time clock. User/video/visibility
pause and not-yet-due replay content therefore do not expire against wall time.
No active card is evicted, queue enlarged, or paid motion accelerated by this
policy. Density subdivision is retained; earlier slot-query counts do not prove
an elapsed-time or FPS improvement.

A deterministic production-selector comparison used twelve one-vacancy cycles,
one paid and one ordinary arrival per cycle, and inexpensive successful placement
stubs. These are placement-model results, not browser first-visible measurements:

| Start preference | Paid placements | Ordinary placements | First ordinary cycle (zero based) |
| --- | ---: | ---: | ---: |
| Existing paid first | 12 | 0 | Not observed |
| 1 higher-priority success per ordinary opportunity | 6 | 6 | 1 |
| Selected 2 successes per ordinary opportunity | 8 | 4 | 2 |
| 4 successes per ordinary opportunity | 10 | 2 | 4 |

The selected threshold keeps paid preference while allowing ordinary service in
this recurring compatible-vacancy case. Actual first-visible delay, residence,
dispositions, occupancy and work require the separate matched browser traces.

Reflow gives messages currently crossing the viewport priority over future or
offscreen entries. It first retains legal placements, then searches legal blocks
for displaced messages within each group before admitting the next group.
Existing order is preserved within each group. Density changes prefer the legal
new-grid position nearest the previous physical Y, rather than retaining a lane
index whose meaning changed. Grid rounding and collision constraints can still
require movement.

Translation and resize preserve the current X coordinate and committed expiry
of already visible scrolling messages. One affine velocity covers the revised
distance by that deadline, so it can differ from the configured nominal speed.
This anchors X rather than both edges when width changes. Fixed messages remain
centered; viewport, collision and capacity changes can require repositioning.
Future reservations retain their geometric entry deadline. A deliberate mode or
speed-policy change can establish one new deadline; unchanged geometry does not
restart or extend the plan.

Accepted reservations rebuild the indexes and conservative lane summaries.
An active message that cannot be reconciled stays hidden in the existing bounded
active array without a lane reservation. Its committed clock and resource owners
remain intact until normal expiry or a later successful reflow. Geometry changes
can restore it while it is alive; expired content is not revived. This adds no
separate retention queue. New pending candidates retain the existing admission
and drop policy.

Worker recovery snapshots use validated epoch timestamps at the cross-thread
boundary, then return to the Canvas monotonic clock. A valid snapshot preserves
active progress, fade start, and future reservations before shared reflow. A
paused snapshot preserves frozen progress. Missing, malformed, timed-out, or
stale motion data uses the bounded retained-message requeue policy; continuity
cannot be recovered from IDs alone. New replacement ingress supersedes the
older snapshot entry. Expired validated active messages are not reactivated.

Replay prefetch is independent of display eligibility. `ReplayBuffer.flushUpTo`
emits reached video offsets only, accepts the existing bounded late tolerance,
and accounts for messages outside that tolerance. Playback pause, seeking, and
session cancellation guard the source boundary. Animation uses monotonic time
after source ingress; it does not reinterpret the prefetch horizon as display
permission or introduce a new playback-rate animation policy.

Translation starts after original message activation. Each Main or Worker
message owns its queued request until replacement, release, pruning, state
clear, or renderer teardown. Pause and replay retain their display clocks;
translation has no separate wall-clock expiry. The queue holds at most 256
requests and 64 KiB of UTF-16 text estimates, with an 8 KiB per-request limit.
Under backlog, two recent requests (favoring paid messages) precede one oldest
surviving request. A native translation uses an AbortSignal, but its browser
slot remains owned until the native Promise actually settles. A 15-second stall
ends local waiting and reports failure; it does not free that slot. If the same
translator still owns the configuration when the call settles, requests resume.
New service instances share ownership through the same Translator API object
and wait up to 1.5 seconds for old native work before reporting failure. A
later settings action can retry after the old work settles. Original messages
continue to render when translation is unavailable.
