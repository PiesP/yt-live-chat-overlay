# YouTube Live Chat Overlay threat model

## System and assets

This repository ships a client-side YouTube live-chat overlay as a userscript and
Chrome/Firefox MV3 extensions. It has no developer-operated backend, account
system, application session, or database. Protect the integrity of the YouTube
page/session, the privacy and integrity of local preferences and in-memory chat,
tab availability, extension/userscript privileges, and release artifacts.

## Trust boundaries and security properties

- Treat YouTube responses, `window.ytInitialData`, `window.ytcfg`, DOM chat
  nodes, message and author fields, emoji metadata, IDs, timestamps, and image
  URLs as untrusted structured data. Parsing must use runtime guards and bounded
  traversal. Chat, settings, and locale text must remain data: Canvas rendering
  and DOM `textContent` are expected; active HTML, SVG, script URLs, dynamic
  code, and unsafe CSS are not.
- `src/chat/youtube/api.ts` may make same-origin YouTube/Innertube requests.
  Image loads must pass `src/media/image-url-validation.ts` and remain HTTPS on
  the approved Google/YouTube CDN suffixes. There is no privileged server-side
  network, so backend SSRF is out of scope; browser tracking, unintended
  credentialed requests, or meaningful private-network access remain relevant.
- `extension/page-script.ts` runs in MAIN world to observe page fetches, while
  `extension/content-script.ts` runs in ISOLATED world and relays narrowly scoped
  extension operations. The bridge validates source, origin, message shape,
  command/key allowlists, and a per-injection random nonce created with
  `crypto.randomUUID()`. The nonce is defense in depth and routing integrity,
  not a secret capability from JavaScript executing in the same page. Do not
  report the bridge as lacking a nonce. Findings must show a path to operations
  beyond the one non-secret settings key or the reset/reload commands.
- Imported JSON and local settings are operator-controlled. Schema validation,
  normalization, numeric bounds, migration bounds, prototype-pollution guards,
  and safe persistence must prevent executable or irrecoverable state. Settings
  are preferences, not credentials or YouTube tokens.
- Remote workloads must remain bounded. Review chat/replay queues, seen-ID
  registries, per-author rate limits, traversal limits, byte-bounded media and
  translation caches, image concurrency/timeouts, worker health and teardown,
  polling circuit breakers, and visibility/playback pausing. A finding needs a
  reproducible path that defeats these controls, not merely a large input.
- Translation is optional and uses the browser's built-in Translator/Language
  Detector APIs. The project must not send chat text to a developer-operated or
  third-party translation endpoint contrary to `PRIVACY.md`.
- Build scripts, Vite configuration, manifests, pinned Actions, release tags,
  dependencies, credentials, checksums, and publication workflows form the
  supply-chain boundary. A release-path compromise can affect installed or
  automatically updated userscript and extension code.

## Shared dependency boundary

`packages/core` is a pinned Git submodule providing `@piesp/browser-core`.
Review calls into it as a trust boundary and include the checked-out code when
available, but distinguish a defect in this repository's integration from a
shared-core defect. Do not propose changing the gitlink without verifying that
the target commit is reachable from the upstream repository and validating all
consumers.

## Severity and exclusions

Calibrate severity from attacker control, user interaction, privilege gained,
data sensitivity, persistence, reproducibility, and affected-user scope.
Arbitrary code execution with YouTube/extension/userscript privilege, credential
or sensitive-chat exfiltration, and malicious release publication are severe.
Same-page message spoofing or modification of non-secret preferences without a
new privilege is normally low or medium depending on persistence and impact.

Server-side CSRF, SQL injection, backend SSRF, RBAC bypass, multi-tenant data
isolation, and session fixation are unsupported classes because no such server
authority exists. Dependency advisories without a reachable project-specific
attack path belong to OSV/dependency triage rather than a source vulnerability.

## Required deferred runtime coverage

Static review cannot establish behavior on live YouTube pages, browser/extension
store state, redirects and response behavior of real CDN hosts, or native memory
held by Canvas2D, OffscreenCanvas, ImageBitmap, browser decoders, and workers.
Record those areas as deferred unless the scan has corresponding browser,
network, process-memory, store, or release evidence. Do not infer full runtime
coverage from unit tests or JavaScript heap behavior alone.
