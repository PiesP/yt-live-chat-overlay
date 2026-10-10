# Rendering timing contract

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
ignores it, including while pending. Speed settings become authoritative at
placement and at deliberate resize, translation, or settings reflow. A committed
motion plan keeps its velocity and reservation until collision-aware reflow;
pause and recovery preserve its elapsed progress and future entry.

Vertical geometry uses the saved `fontSize` in logical pixels for measurement,
regular drawing, prewarming, lane creation and reflow in both renderers.
Resizing/fullscreen changes capacity and paid-card width without resizing text.
Legacy responsive sizing preferences remain stored but do not scale the lanes.
Transparent regular comments keep outline/antialiasing and photo overflow without
decorative vertical card padding; visible backgrounds retain their card insets.
Top-baseline font envelopes and cached actual-content bounds account for CJK,
fallback fonts, combining marks and emoji. Outlined bitmaps preserve above-origin
ink and its draw origin. Horizontal padding and wrapping are unchanged.

`laneSpacing` is additional logical-pixel separation outside each content
rectangle. Its existing 0–20 range, 1px step and default zero remain unchanged.
The ordinary row pitch is its complete compact height plus this gap. Density
factors 1, 0.75 and 0.5 select 1, 2 and 4 subdivisions of that pitch; an ordinary
row reserves all its subdivisions, so finer grids do not claim more ordinary
capacity or increase its pitch. Genuinely taller author, translation and paid
content reserves `ceil((height + gap) / gridHeight)` slots. Its remaining discrete
rounding space is centered around content, excluding the user gap. Reservations
and reflow use the same rule. Spread still spans the full safe zone and may
leave unused rows or future reservations. The settings preview paints three
rows with the shared estimate, reservation and drawing code.

Live entry pacing groups messages by queue priority and speed tier. Backlog
messages retain their existing lower priority. Temporal delay and horizontal
offset share the adaptive entry window. A group's previous geometric entry is
retained across frames when it fits that window; an earlier long lane wait can
be overtaken rather than blocking an unrelated free lane. Replay bypasses these
optional effects. Lane availability and collision safety can still delay entry.
Geometric entry means crossing the viewport edge, independently of fade opacity.

Drain attempts include failures in both the count and elapsed-work limits.
Higher priority groups are normally examined first. Each group's identity cursor
rotates past repeated failures; after a time-budget interruption, the next group
receives the first attempt in the following drain. Successful placements and
permanently oversized messages are removed; transient failures remain in the
existing bounded queue. The anti-block gate retains its priority bypass, replay
policy, and forced retry deadline.

Reflow first retains legal placements, then searches legal blocks for displaced
messages. It preserves future entry deadlines and normalized elapsed progress.
All accepted reservations rebuild the indexes and conservative lane summaries.
Messages too tall for the viewport receive `oversized`; messages without a
collision-free block receive `reflow_capacity`. Capacity loss is a permanent
disposition rather than an overlapping draw or an additional retention queue.

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
