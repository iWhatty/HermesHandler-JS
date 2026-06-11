# CHANGELOG — `hermes-handler`

> Initial cut seeded from `git log` by the host repo's `tools/seed-changelogs.mjs` script. Version groupings infer release boundaries from tags and commit subjects; rough cuts are expected — review and tighten as part of normal maintenance.

## 1.1.0 — 2026-06-11 (unpublished; awaiting release approval)

- feat: zero-copy Transferables, both directions. `dispatch({ transfer })` forwards a transfer list as the transport's second `send` argument; handlers declare response transferables via `ctx.transfer(...)`, carried outside the frozen envelope in a WeakMap (`getTransferList` / `setTransferList` exported from the root).
- feat: `servePostMessage(hermes, endpoint, opts?)` — router-side mirror of `postMessageTransport`. Serves a HermesHandler from a Web Worker, MessagePort, or Window; honors `ctx.transfer` lists; fire-and-forget for messages without a `requestId`; same inbound/outbound discriminators.
- Backward compatible: wire shape unchanged; existing transports ignore the new optional `send` argument.

## Unreleased — 2026-05-21

- test: silence expected timeout logs  `9e7d4eb`

## 1.0.3 — 2026-05-21

- docs(pkg): scrub em dash from npm description  `2bc8655`
- chore(pkg): update GitHub repo URL after rename  `facd5ac`
- Update success envelope shorthand normalization  `afc57ba`
- Clarify envelope info normalization  `65356ee`

## 1.0.2 — 2026-05-20

_(no commits in this range)_

## 1.0.1 — 2026-05-20

_(no commits in this range)_

## 1.0.0 — 2026-05-20

- fix(types): JSDoc annotation for normalizePayload non-envelope wrap (follow-up to 3fa6fc3)  `ddd9e66`

## 0.2.0 — 2026-05-20

_(no commits in this range)_

## 0.1.0 — 2026-05-20

- fix(transports): JSDoc types for tsc --strict (follow-up to 7bd9c07)  `3719cad`

## 0.0.8 — 2026-05-20

_(no commits in this range)_

## 0.0.7 — 2026-05-20

_(no commits in this range)_

## 0.0.6 — 2026-05-19

- docs(README): apply @whatty README template  `29c20ba`
- chore(license): finalize AGPL-3.0 + WATT3D Additional Terms metadata  `05fe8b7`

## 0.0.5 — 2026-05-19

- chore: normalize README shields row  `24676a0`
- feat: relicense to AGPL-3.0 + WATT3D AI Training Rider  `98c3a70`
- chore: deploy WATT3D AI-bot robots.txt policy  `a67a693`
- chore: revise AI Training Rider (v2 — pre-counsel drafting fixes)  `4ed0db4`
- chore: rider v3 — remove gameable 0.1% safe harbor  `b2f20ef`
- chore: rider v4 — Commercial Use restricted to Fully Open Source  `51e10be`

## 0.0.4 — 2026-05-12

- feat: refine response envelope and normalize logic (v0.0.3)  `7bbc236`
- re-worded response types for clarity  `70e0da2`
- Add listener ownership controls  `3dccadd`
- Add repo readiness docs and pnpm workflow  `ab9c664`
- Document Codex Windows workflow  `1a364e4`

## 0.0.2 — 2026-02-14

- added API note for logger in readme  `0eb9ab7`
- added keywords to package.json  `e3cac81`
- Added more types to index.js  `f8a25be`

## 0.0.1 — 2026-02-12

- Initial commit  `79b230f`
- feat: initial release of HermesHandler  `302d295`
