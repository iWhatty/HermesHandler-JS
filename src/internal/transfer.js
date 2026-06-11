// src/internal/transfer.js
//
// Transferable-list registry for response envelopes.
//
// Response envelopes are normalized and FROZEN before they reach a
// transport (see envelope.js), and the normalizer shunts any
// non-canonical field into `info` — so a transfer list can't ride on
// the envelope itself without either mutating frozen objects or
// polluting the wire shape. Instead the list rides OUTSIDE the
// envelope in a WeakMap keyed by the (frozen) envelope object:
//
//   - invisible to structured clone / JSON / Object.keys, so the wire
//     payload stays byte-identical for consumers that ignore transfer
//   - no mutation of frozen envelopes
//   - garbage-collects with the envelope; nothing to clean up
//
// The router writes via `setTransferList` when a handler calls
// `ctx.transfer(...)`. Serving glue (e.g. `servePostMessage`) reads
// via `getTransferList` and passes the result as the postMessage
// transfer argument. Exported publicly for hand-rolled transports.

/** @type {WeakMap<object, Transferable[]>} */
const REGISTRY = new WeakMap();

/**
 * Associate a transfer list with a response envelope. Replaces any
 * previously-registered list for the same envelope object.
 *
 * @param {object} envelope  The (possibly frozen) response envelope.
 * @param {Transferable[]} transferables
 */
export function setTransferList(envelope, transferables) {
    if (!envelope || typeof envelope !== "object") return;
    if (!Array.isArray(transferables) || transferables.length === 0) return;
    REGISTRY.set(envelope, transferables);
}

/**
 * Read the transfer list registered for a response envelope.
 * Returns an empty array when none was registered, so callers can pass
 * the result straight to `postMessage(msg, transfer)`.
 *
 * @param {object} envelope
 * @returns {Transferable[]}
 */
export function getTransferList(envelope) {
    if (!envelope || typeof envelope !== "object") return [];
    return REGISTRY.get(envelope) ?? [];
}
