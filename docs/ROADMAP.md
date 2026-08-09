# Roadmap

HermesHandler works well as a browser-extension runtime message router today. The next useful step is to keep that use case excellent while naming the more general primitive underneath: a small message dispatch contract for JavaScript runtimes.

HermesHandler is also a public npm package used by existing applications. Roadmap work should preserve the current wire envelope, listener ownership defaults, timeout defaults, and published subpaths unless a major-version migration explicitly says otherwise. Prefer additive APIs and focused bug fixes over broad rewrites.

## Release Boundaries

- **Patch:** build and packaging fixes, declaration/runtime parity, transport error propagation, lifecycle behavior that already matches documented intent, documentation corrections, and additional tests.
- **Minor:** additive adapters, opt-in stricter types, new validation that may expose invalid existing usage, and new serving helpers.
- **Major:** wire-envelope changes, changed timeout or listener-ownership defaults, removal or renaming of exports, and stricter existing client types that reject previously accepted programs.

## Near-Term Hardening

- Keep builds and package verification OS-agnostic across Windows, macOS, and Linux.
- Test the built package entry points so runtime exports, declarations, and `package.json#exports` cannot drift apart.
- Surface Chrome runtime send failures as correlated Hermes error envelopes instead of delayed client timeouts.
- Make client shutdown terminal and idempotent: unsubscribe once, settle pending requests, and reject post-close dispatch without touching the transport.
- Start `MessagePort` endpoints when required and cover the path with a real `MessageChannel` integration test.
- Keep listener ownership controls focused: `ignoreUnknown` for common multi-listener extension pages, `shouldHandle` for scoped ownership rules.
- Add more tests around callback-style `sendResponse`, thrown `shouldHandle` predicates, and malformed messages.
- Keep direct `dispatch()` behavior deterministic for tests, non-extension runtimes, and adapters.
- Add type-level examples once the public option surface settles.

The client lifecycle currently needs only an explicit `open`/`closed` state and shared settlement helpers. Introduce a larger state-machine abstraction only if future lifecycle states or transitions make the linear model genuinely hard to reason about.

## Developer Experience

- Validate clearly invalid factory options and route names early with precise errors, while preserving documented `timeoutMs: 0` behavior.
- Keep source comments focused on local invariants; put longer tutorials and integration guidance in the README or dedicated docs.
- Refactor the large dispatch implementation only after behavior tests lock down its semantics. Prefer small named helpers for message validation, context creation, route invocation, middleware composition, and response finalization.
- Document that local client abort stops waiting but does not remotely cancel server work unless a transport-level cancellation protocol is added.

## Type Safety

The current client request types are intentionally permissive about omitted payloads. Tightening them in place could break TypeScript consumers.

- Add opt-in strict client types that distinguish routes with no payload, an optional payload, and a required payload.
- Exercise those types against the public package entry points.
- Gather migration feedback from existing applications before considering strict payload typing as the default in a future major version.

## General JavaScript Direction

HermesHandler does not need to be Chrome-extension-only. The current core already works as a framework-agnostic router when callers use `dispatch()`.

Useful adapter targets:

- Browser extension runtime listeners.
- Web worker and service worker message events.
- Node `MessagePort`, event emitters, or lightweight RPC channels.
- Test harnesses and agent tool buses.

The core should stay transport-agnostic. Transport-specific helpers should be thin adapters around the same message envelope and handler map.

## API Ideas

- `createRuntimeListener(hermes, options)` if browser-specific behavior grows beyond `getListener()`.
- `createMessageEventListener(hermes)` for worker-style `postMessage` flows.
- A generic `serveTransport(hermes, transport)` if multiple applications repeat the same request/reply serving lifecycle.
- Optional request validation hooks before dispatch.
- Optional error classification helpers for richer `info` metadata.
- A small TypeScript generic story for typed handler maps and typed `dispatch()`.
- Opt-in typed broadcast events without increasing the weight of the default client.

## Non-Goals

- No runtime dependencies for the core package.
- No framework-specific assumptions.
- No silent changes to the response envelope.
- No generalized lifecycle framework until the concrete state model requires one.
- No automatic npm publishing from routine development commits.
