# CI scripts

`deep-check-reuse.ts` fingerprints the checked-out Git inputs, validates a
successful cached marker, and writes a marker only after a deep gate succeeds.
It runs directly on the manifest-pinned Node runtime with
`node --experimental-strip-types`; no dependency install is needed for marker
decisions. The companion Node test runs through `pnpm test:ci`, and both files
are typechecked through `pnpm check:scripts` as part of `pnpm quality`.

Each deep-check job configures the pinned Node and pnpm toolchain before
fingerprinting. The early setup uses `install-dependencies: 'false'`, so a deep
marker cache restore failure or miss still leaves the runtime ready to evaluate
the marker. Fast and renderer mutation jobs run the normal, frozen dependency setup
only when they cannot reuse a successful marker. The duplication job installs
Nose only for a fresh check.
