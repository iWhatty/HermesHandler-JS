# hermes-handler

[![npm](https://img.shields.io/npm/v/hermes-handler)](https://www.npmjs.com/package/hermes-handler)
[![downloads](https://img.shields.io/npm/dm/hermes-handler)](https://www.npmjs.com/package/hermes-handler)
[![bundle size](https://img.shields.io/bundlephobia/minzip/hermes-handler)](https://bundlephobia.com/package/hermes-handler)
[![license](https://img.shields.io/npm/l/hermes-handler)](https://github.com/iWhatty/HermesHandler-JS/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/iWhatty/HermesHandler-JS?style=social)](https://github.com/iWhatty/HermesHandler-JS)

Lightweight, framework-agnostic message router for browser extensions and event-driven systems. Strict response envelope, built-in timeouts, cooperative cancellation, and a tiny client subpath for size-sensitive bundles.

## Features

- Deterministic message routing via `type`
- Strict response envelope: `{ ok:true, result?, info? } | { ok:false, error, info? }`
- Built-in timeout handling
- Cooperative cancellation via `AbortSignal`
- Immutable (shallow-frozen) responses
- LLM-friendly deterministic contract
- Framework-agnostic (no runtime dependencies)
- Type-safe via generated `.d.ts`
- Tiny client-side helper via `hermes-handler/client` subpath (≈ 1 KB minified). Speaks the same wire envelope without bringing the router class into size-sensitive bundles.
- Zero-copy worker RPC: `transfer` on requests, `ctx.transfer(...)` on responses, and `servePostMessage(hermes, self)` to serve a router from a Web Worker — Transferables move instead of being structured-cloned.

---

## Install

```sh
pnpm add hermes-handler
```

---

## Quick start

```js
import { HermesHandler } from "hermes-handler";

const handlers = {
  ping: () => ({ ok: true, result: "pong" }),

  greet: (msg) => {
    return { ok: true, result: `Hello ${msg.payload.name}` };
  }
};

const hermes = new HermesHandler(handlers);

const res = await hermes.dispatch({ type: "ping" });

if (res.ok) {
  console.log(res.result); // "pong"
}
```

---

## API

### `new HermesHandler(initialHandlers?, options?)`

**initialHandlers**
`Record<string, HermesHandlerFn>`

**options**

- `timeoutMs?: number`
- `onUnknown?: (msg, ctx) => HermesResponse`
- `onError?: (err, msg, ctx) => HermesResponse`
- `ignoreUnknown?: boolean`
- `shouldHandle?: (msg, sender) => boolean`
- `logger?: HermesLogger | null`

### `.register(type, fn)`

Register or overwrite a handler.

### `.registerMany(map)`

Register multiple handlers at once.

### `.unregister(type)`

Remove a handler.

### `.has(type)`

Check if a handler exists.

### `.getListener()`

Returns a runtime-compatible message listener.

### `.dispatch(msg, sender?)`

Dispatch a message manually (useful for testing or non-extension environments).

### `.types()`

List registered message types (registration order).

### Response envelope

All wire responses follow a strict envelope. Handler returns may use ergonomic shorthand, but Hermes normalizes every settled response before it leaves the router. Payload belongs under `result`, diagnostics belong under `info`, failures belong under `error`, and `requestId` is echoed from the request unless the handler provides one.

**Success**

```js
{ ok: true, result: any, info?: any }
```

**Error**

```js
{ ok: false, error: string, info?: any }
```

Primitive and non-envelope return values are automatically normalized:

```js
return "hello";
// -> { ok: true, result: "hello" }

return { sourceCandidates };
// -> { ok: true, result: { sourceCandidates } }
```

Success envelopes with an explicit `result` keep that result as the primary payload. Extra top-level fields are treated as diagnostics and moved into `info`:

```js
return { ok: true, result: { sourceCandidates }, diagnostics, warnings };
// -> { ok: true, result: { sourceCandidates }, info: { diagnostics, warnings } }
```

Success envelopes without an explicit `result` treat non-canonical top-level fields as the primary payload:

```js
return { ok: true, sourceCandidates };
// -> { ok: true, result: { sourceCandidates } }

return { ok: true, sourceCandidates, info: { timingMs: 12 } };
// -> { ok: true, result: { sourceCandidates }, info: { timingMs: 12 } }

return { ok: true, error: "not actually failed" };
// -> { ok: true, info: { error: "not actually failed" } }
```

Fields reserved for the opposite branch, such as `error` on `ok:true`, are treated as diagnostics instead of success payload.

Error envelopes stay strict: `ok:false` must include a string `error`. Canonical `info` is preserved as `info`. Extra fields on errors are moved into `info`; if the handler also provided `info`, Hermes preserves it under `info.handlerInfo` when combining it with those extras. Malformed envelopes are coerced into valid error responses.

### Handler return contract

Every handler MUST settle the response by one of:

1. **Return a value.** Primitives → `{ ok: true, result: value }`. Full envelopes (`{ ok, result?, error? }`) are normalized into canonical wire envelopes. Promises are awaited.
2. **Call `ctx.send(payload)`.** Sync or async, before the handler's returned Promise settles. Subsequent `ctx.send` calls are ignored (idempotent).

Returning `undefined` WITHOUT calling `ctx.send` settles the dispatch with `{ ok: false, error: "Handler ${type} returned no response" }` — this is treated as a handler bug, not a valid envelope.

```js
// ✅ return-value style
{ ping: () => 'pong' }

// ✅ full-envelope return
{ ping: () => ({ ok: true, result: 'pong' }) }

// ✅ ctx.send style (sync)
{ ping: (_msg, ctx) => { ctx.send('pong'); } }

// ✅ ctx.send style (async)
{ slow: async (_msg, ctx) => {
    const data = await fetchSomething();
    ctx.send({ ok: true, result: data });
  } }

// ❌ returns undefined, never sends — settles with "returned no response" error
{ bad: () => { doSideEffect(); } }
```

If both ctx.send and a return value are present, ctx.send wins (it settles first).

---

## Notes

### Browser extension usage

Attach hermes-handler to a runtime listener:

```js
browser.runtime.onMessage.addListener(
  hermes.getListener()
);
```

Both styles are supported:

- Promise-returning listeners (MV3 / Firefox / polyfill)
- Callback-style `sendResponse + return true`

#### Ignoring messages owned by other listeners

Browser extensions can have multiple `runtime.onMessage` listeners alive at the same time. By default, hermes-handler preserves its original behavior and responds to unknown message types with an error envelope.

If a listener should only claim messages it knows how to handle, enable `ignoreUnknown`:

```js
const hermes = new HermesHandler(handlers, {
  ignoreUnknown: true
});
```

When `ignoreUnknown` is enabled, `getListener()` returns `false` for runtime messages whose `type` is missing or not registered. That lets another listener handle the message instead of racing it with an unknown-message response.

For scoped extension pages or richer ownership rules, provide `shouldHandle`:

```js
const hermes = new HermesHandler(handlers, {
  shouldHandle: (msg) => msg?.scope === "popup" || hermes.has(msg?.type)
});
```

When `shouldHandle` is provided, it is the runtime listener ownership predicate. If it returns `true`, hermes-handler uses normal dispatch behavior. If it returns `false`, the listener returns `false` without sending a response.

### Half-and-half: server router + tiny client

hermes-handler has two natural sides:

- **Server side.** Runs the handlers. You want the full `HermesHandler` class here (routing, normalization, per-handler timeout, AbortSignal plumbing).
- **Client side.** Sends a request and parses the envelope. You don't need the router; you need ~1 KB of wire-correlation glue.

For size-sensitive contexts (page-world bundles, popups, child processes), import the client subpath instead of the class:

```js
// page-world / popup / inline-injected bundle
import { createHermesClient } from "hermes-handler/client";

const dispatch = createHermesClient({
  send:      (msg) => window.parent.postMessage(msg, "*"),
  subscribe: (handler) => {
    const listener = (e) => handler(e.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  },
  defaultTimeoutMs: 8000,
});

const res = await dispatch({ type: "code-source.fetch", payload: { url } });
if (res.ok) console.log(res.result);
else        console.warn(res.error, res.info);
```

`createHermesClient` handles `requestId` correlation, per-call timeout, `AbortSignal`, and envelope normalization. The wire shape is the contract; the client is one implementation of it. Half-and-half is fine and often correct.

### Workers + zero-copy transferables

The classic worker-RPC pattern — main thread sends a large binary payload
(ImageData, audio buffer, ArrayBuffer), worker computes, sends a large
result back — needs **Transferables** to avoid structured-cloning
megabytes in both directions. Three pieces cover it end to end:

```js
// ---- worker.js (module worker) ----
import { HermesHandler } from "hermes-handler";
import { servePostMessage } from "hermes-handler/transports/postmessage";

const hermes = new HermesHandler({
  invert: { timeoutMs: 0, handler: (msg, ctx) => {   // 0 = no budget; heavy compute
    const out = invertPixels(msg.payload);            // { width, height, data: ArrayBuffer }
    ctx.transfer(out.data);                           // MOVE the buffer back, don't clone
    return { ok: true, result: out };
  } },
});
servePostMessage(hermes, self);

// ---- main.js ----
import { createHermesClient } from "hermes-handler/client";
import { postMessageTransport } from "hermes-handler/transports/postmessage";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const dispatch = createHermesClient(postMessageTransport(worker));

const buf = imageData.data.slice().buffer;            // copy once, then MOVE
const res = await dispatch({
  type: "invert",
  payload: { width, height, data: buf },
  transfer: [buf],                                    // request buffer moves to the worker
  timeoutMs: 0,
});
```

Mechanics:

- **Requests**: `dispatch({ ..., transfer: [...] })` forwards the list as
  the transport's second `send` argument. After the send, transferred
  buffers are neutered on the sending side — copy first if you still need
  them (the snippet's `.slice()`).
- **Responses**: handlers call `ctx.transfer(...)`; the list rides
  *outside* the frozen envelope (WeakMap keyed by envelope identity, so
  the wire payload is byte-identical for consumers that ignore it).
  `servePostMessage` reads it automatically; hand-rolled glue can use
  `getTransferList(envelope)` from the root export.
- **Transports that can't transfer** (`chrome-runtime`,
  `broadcast-channel`) ignore the list — payloads still arrive, via
  copy. No behavioural fork in your code.

`servePostMessage(hermes, endpoint, opts?)` is the router-side mirror of
`postMessageTransport`: same `inbound`/`outbound` discriminators, same
`filter`, plus fire-and-forget semantics for messages without a
`requestId`. It returns an unsubscribe function.

### Timeouts

Handlers can be time-limited:

```js
const hermes = new HermesHandler(handlers, {
  timeoutMs: 7000
});
```

If exceeded, hermes-handler returns:

```js
{ ok: false, error: "Handler <type> timed out (7000 ms)" }
```

Pick a timeout longer than the longest legitimate handler. If any handler awaits a `fetch()` or other network call, match or exceed that call's own timeout. Use `timeoutMs: 0` to opt out entirely when the caller doesn't care about the reply.

### Cooperative cancellation

Each handler receives an `AbortSignal`:

```js
async function longTask(msg, ctx) {
  if (ctx.signal?.aborted) {
    return { ok: false, error: "Cancelled" };
  }

  ctx.signal?.addEventListener("abort", () => {
    console.log("Cancelled externally");
  });
}
```

hermes-handler aborts the signal once a request lifecycle completes.

### Logging

hermes-handler emits warnings and errors through a configurable logger. By default, it uses the global `console`. You can disable logging entirely or provide a custom logger implementation.

**Disable logging**

```js
const hermes = new HermesHandler(handlers, {
  logger: null
});
```

**Custom logger**

```js
const hermes = new HermesHandler(handlers, {
  logger: {
    warn: (...args) => myLogger.warn(...args),
    error: (...args) => myLogger.error(...args)
  }
});
```

**HermesLogger shape**

```ts
interface HermesLogger {
  debug?(message?: any, ...optionalParams: any[]): void;
  info?(message?: any, ...optionalParams: any[]): void;
  warn?(message?: any, ...optionalParams: any[]): void;
  error?(message?: any, ...optionalParams: any[]): void;
}
```

If `logger` is `null`, hermes-handler will not emit any console output.

### Design goals

hermes-handler enforces a predictable and deterministic runtime contract. By standardizing request/response handling and isolating message dispatch logic, it simplifies reasoning about complex systems, particularly those involving automation, background scripts, or LLM-driven tool execution. The core remains intentionally minimal, dependency-free, and portable.

### Project docs

- [Publishing checklist](docs/PUBLISHING.md)
- [Roadmap and API direction](docs/ROADMAP.md)

---

## License

Licensed under AGPL-3.0 with WATT3D Additional Terms. See [LICENSE](./LICENSE) and [ADDITIONAL_TERMS.md](./ADDITIONAL_TERMS.md). Commercial AI/model-training use requires compliance with those terms or a separate WATT3D license. © WATT3D.
