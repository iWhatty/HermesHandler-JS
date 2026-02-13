# HermesHandler

HermesHandler is a lightweight, framework-agnostic message router for browser extensions and event-driven systems. It provides structured request dispatching, a strict `{ ok, result, error }` response envelope, timeout handling, cooperative cancellation, and safe normalization.

Designed for reliability and clarity, HermesHandler is especially well-suited for LLM-driven agents, modular browser architectures, automation layers, and distributed runtime systems.

---

## ✨ Features

* 🔁 Deterministic message routing via `type`
* 📦 Strict response envelope: `{ ok, result?, error? }`
* ⏱ Built-in timeout handling
* 🛑 Cooperative cancellation via `AbortSignal`
* 🧊 Immutable (shallow-frozen) responses
* 🧠 LLM-friendly deterministic contract
* 🧩 Framework-agnostic (no runtime dependencies)
* 📘 Type-safe via generated `.d.ts`

---

## Installation

```bash
npm install hermes-handler
```

---

## Quick Start

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

## Browser Extension Usage

Attach HermesHandler to a runtime listener:

```js
browser.runtime.onMessage.addListener(
  hermes.getListener()
);
```

HermesHandler supports both:

* Promise-returning listeners (MV3 / Firefox / polyfill)
* Callback-style `sendResponse + return true`

---

## Response Contract

All responses follow a strict envelope.

### Success

```js
{ ok: true, result: any }
```

### Error

```js
{ ok: false, error: string, details?: any }
```

Primitive return values are automatically normalized:

```js
return "hello";
```

Becomes:

```js
{ ok: true, result: "hello" }
```

Malformed responses are safely coerced into valid error envelopes.

---

## Timeouts

Handlers can be time-limited:

```js
const hermes = new HermesHandler(handlers, {
  timeoutMs: 7000
});
```

If exceeded, HermesHandler returns:

```js
{ ok: false, error: "Handler <type> timed out (7000 ms)" }
```

---

## Cooperative Cancellation

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

HermesHandler aborts the signal once a request lifecycle completes.

---

## API

### `new HermesHandler(initialHandlers?, options?)`

**initialHandlers**
`Record<string, HermesHandlerFn>`

**options**

* `timeoutMs?: number`
* `onUnknown?: (msg, ctx) => HermesResponse`
* `onError?: (err, msg, ctx) => HermesResponse`

---

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

---

## Logging

HermesHandler emits warnings and errors through a configurable logger.

By default, it uses the global `console`. You can disable logging entirely or provide a custom logger implementation.

### Disable Logging

```js
const hermes = new HermesHandler(handlers, {
  logger: null
});
```

### Custom Logger

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

If `logger` is `null`, HermesHandler will not emit any console output.

---

## Design Goals

HermesHandler enforces a predictable and deterministic runtime contract. By standardizing request/response handling and isolating message dispatch logic, it simplifies reasoning about complex systems—particularly those involving automation, background scripts, or LLM-driven tool execution.

The core remains intentionally minimal, dependency-free, and portable.

---

## License

MIT
