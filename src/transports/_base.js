// src/transports/_base.js
//
// Shared scaffold for transport adapters. Each adapter
// (postmessage/chrome-runtime/broadcast-channel/...) wraps a different
// underlying mechanism but must return the same canonical
// `{ send, subscribe }` contract for `createHermesClient`. This module
// centralizes the contract validation so adapters stay focused on
// transport-specific glue.

/**
 * @typedef {Object} HermesTransport
 * @property {(msg: any, transfer?: Transferable[]) => void} send
 *   Called once per dispatch. Fire-and-forget; replies arrive via
 *   subscribe. May throw on transport unavailability — the client
 *   converts those to error envelopes. The optional second argument is
 *   the request's transfer list; adapters over channels that support
 *   transfer (postMessage) forward it, others ignore it (the payload
 *   still arrives, via structured clone / serialization).
 * @property {(handler: (msg: any) => void) => () => void} subscribe
 *   Subscribe to incoming messages. Called ONCE at client construction.
 *   Must return an unsubscribe function invoked on `.close()`.
 */

/**
 * Validate that a transport adapter returns the contract
 * `createHermesClient` expects. Throws on malformed input with a
 * pointer-to-the-adapter error so author mistakes surface immediately
 * (vs silently producing a broken client).
 *
 * @template {Record<string, any>} T
 * @param {string} adapterName  Used in error messages for diagnostics.
 * @param {T} impl
 * @returns {T}
 */
export function defineTransport(adapterName, impl) {
    if (!impl || typeof impl !== "object") {
        throw new TypeError(`${adapterName}: transport must return an object with send + subscribe`);
    }
    if (typeof impl.send !== "function") {
        throw new TypeError(`${adapterName}: transport.send must be a function`);
    }
    if (typeof impl.subscribe !== "function") {
        throw new TypeError(`${adapterName}: transport.subscribe must be a function`);
    }
    return impl;
}
