# Codex Security scan instructions

Review this repository as a client-only YouTube userscript and MV3 extension,
using `threat-model.md`, `.github/SECURITY.md`, and `PRIVACY.md` as context.

For every candidate finding:

1. Trace an attacker-controlled source through parsing, normalization, storage,
   messaging, rendering, URL handling, or build/release logic to a concrete
   security-sensitive sink.
2. Cite exact source locations and the relevant preventive controls. Establish
   reachability in the shipped userscript, Chrome extension, or Firefox
   extension and state the required attacker capability and user interaction.
3. Test the claim against runtime guards, Canvas/`textContent` rendering, URL
   parsing and CDN allowlists, the MAIN/ISOLATED bridge's random nonce and
   allowlists, settings normalization, and resource caps. Never claim that the
   bridge lacks a nonce.
4. Separate security impact from product robustness. Calibrate severity from
   effective privilege, sensitive data, persistence, reproducibility, and scope.

Prioritize untrusted YouTube data and DOM/page state, chat parsing and rendering,
same-origin Innertube requests, image URLs and redirects, fetch interception,
MAIN-to-ISOLATED messaging, local/GM/extension storage, imported settings,
translation privacy, bounded chat/media/worker workloads, manifest permissions,
and build/release or `packages/core` supply-chain paths.

Suppress or exclude candidates that rely only on a nonexistent backend,
database, account/RBAC/session system, privileged server network, or
multi-tenant authority. Do not promote a package advisory already handled by
OSV to a source finding without a reachable, project-specific attack path. Mark
sanitizer keywords, dangerous API names, regex matches, or theoretical resource
growth as unsupported until source-to-sink and control analysis validates them.

Explicitly record as deferred unless directly exercised: real YouTube browser
and extension behavior; Canvas/OffscreenCanvas/ImageBitmap/decoder/worker native
memory and tab stability; live CDN redirects and network responses; Chrome and
Firefox store review state; installed userscript-manager behavior; and deployed
release/CDN state. Coverage must remain partial or list open questions when
these limits matter to the conclusion.
