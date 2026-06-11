// src/transports/postmessage.js
//
// Transport adapter for `window.postMessage` style messaging. Plugs into
// `createHermesClient` from `hermes-handler/client`.
//
// Common shapes this covers:
//   - Page-world ↔ content-script bridges (iframe-style same-window)
//   - Parent ↔ child iframe communication
//   - Worker ↔ main thread (postMessage-compatible)
//
// Discriminators (optional): if the same postMessage stream carries
// unrelated traffic, attach a `source` field to outbound messages and
// require it on inbound. Both `outbound` and `inbound` are merged onto
// the canonical envelope; missing values aren't enforced.
//
// Usage:
//
//   import { createHermesClient } from 'hermes-handler/client';
//   import { postMessageTransport } from 'hermes-handler/transports/postmessage';
//
//   const dispatch = createHermesClient(
//     postMessageTransport(window, {
//       outbound: { source: 'app-page' },
//       inbound:  { source: 'app-extension' },
//     })
//   );
//
// To use on the server side, mirror by reading the discriminator off
// inbound traffic and posting responses with the outbound one.

/**
 * @typedef {Object} PostMessageTransportOptions
 * @property {Record<string, any>} [outbound]
 *   Fields merged onto every outbound message (alongside the canonical
 *   `{ type, payload, requestId }` envelope).
 * @property {Record<string, any>} [inbound]
 *   Fields the inbound message must match. If any key disagrees, the
 *   message is dropped silently. Useful for filtering out cross-extension
 *   chatter on `window.postMessage`.
 * @property {string} [targetOrigin='*']
 *   `window.postMessage` targetOrigin. Defaults to '*' (matches the
 *   pre-adapter manual usage). Restrict in production.
 * @property {(MessageEvent: any) => boolean} [filter]
 *   Extra inbound predicate. Returns true to accept. Composes with
 *   `inbound`.
 */

import { defineTransport } from "./_base.js";
import { getTransferList } from "../internal/transfer.js";

/**
 * @param {any} target  Window, MessagePort, Worker, or anything with postMessage + addEventListener.
 * @param {PostMessageTransportOptions} [opts]
 */
export function postMessageTransport(target, opts = {}) {
    const { outbound = {}, inbound = {}, targetOrigin = "*", filter } = opts;
    const inboundKeys = Object.keys(inbound);

    if (!target || typeof target.postMessage !== "function") {
        throw new TypeError("postMessageTransport: target must have postMessage()");
    }
    if (typeof target.addEventListener !== "function") {
        throw new TypeError("postMessageTransport: target must have addEventListener()");
    }

    // Window#postMessage takes (msg, targetOrigin). MessagePort/Worker take
    // just (msg). Window has a `location` property; MessagePort doesn't.
    // Cache the branch at construction time so send() stays hot.
    const isWindow = "location" in target || target === globalThis;

    /**
     * @param {any} msg
     * @param {Transferable[]} [transfer]
     */
    const send = (msg, transfer) => {
        const enveloped = { ...outbound, ...msg };
        const hasTransfer = Array.isArray(transfer) && transfer.length > 0;
        if (isWindow) {
            if (hasTransfer) target.postMessage(enveloped, targetOrigin, transfer);
            else target.postMessage(enveloped, targetOrigin);
        } else {
            if (hasTransfer) target.postMessage(enveloped, transfer);
            else target.postMessage(enveloped);
        }
    };

    /** @param {(msg: any) => void} handler */
    const subscribe = (handler) => {
        /** @param {any} event */
        const listener = (event) => {
            // For same-window page↔content bridges, require event.source ===
            // target so we don't pick up our own outbound messages. Messages
            // from Workers and MessagePorts arrive with source === null (per
            // spec — there's no WindowProxy to attribute them to), so a null
            // source must pass: it can never be same-window echo.
            if (event.source != null && event.source !== target && event.source !== globalThis) return;
            const data = event.data;
            if (!data || typeof data !== "object") return;
            for (const k of inboundKeys) {
                if (data[k] !== inbound[k]) return;
            }
            if (filter && !filter(event)) return;
            // Strip the inbound discriminator keys before passing the
            // canonical envelope to the client (it filters by requestId).
            if (inboundKeys.length === 0) {
                handler(data);
            } else {
                const canonical = { ...data };
                for (const k of inboundKeys) delete canonical[k];
                handler(canonical);
            }
        };
        target.addEventListener("message", listener);
        return () => target.removeEventListener("message", listener);
    };

    return defineTransport("postMessageTransport", { send, subscribe });
}

/**
 * @typedef {Object} ServePostMessageOptions
 * @property {Record<string, any>} [outbound]
 *   Fields merged onto every outbound response envelope.
 * @property {Record<string, any>} [inbound]
 *   Fields an inbound request must match; mismatches are dropped
 *   silently. Mirror of `postMessageTransport`'s discriminators.
 * @property {string} [targetOrigin='*']
 *   Window#postMessage targetOrigin for responses. Restrict in production.
 * @property {(event: any) => boolean} [filter]
 *   Extra inbound predicate. Returns true to accept.
 */

/**
 * Serve a HermesHandler over a postMessage endpoint — the router-side
 * mirror of `postMessageTransport`. Listens for canonical
 * `{ type, payload, requestId }` requests, dispatches through the
 * router, and posts the response envelope back with the requestId the
 * client correlates on. Messages WITHOUT a requestId are dispatched
 * fire-and-forget (no response posted).
 *
 * Typical worker-side usage (module worker):
 *
 *   import { HermesHandler } from 'hermes-handler';
 *   import { servePostMessage } from 'hermes-handler/transports/postmessage';
 *
 *   const hermes = new HermesHandler({
 *     resize: { timeoutMs: 0, handler: (msg, ctx) => {
 *       const out = heavyResize(msg.payload);       // ImageData-shaped
 *       ctx.transfer(out.data.buffer);              // zero-copy reply
 *       return { ok: true, result: out };
 *     } },
 *   });
 *   servePostMessage(hermes, self);
 *
 * Responses honor transfer lists declared via `ctx.transfer(...)` in
 * the handler (see HermesHandler) — the listed buffers MOVE to the
 * client instead of being structured-cloned.
 *
 * @param {{ dispatch: (msg: any, sender?: any) => Promise<any> }} hermes
 *   A HermesHandler (or anything dispatch-shaped).
 * @param {any} endpoint  Worker global (`self`), Worker, MessagePort, or
 *   Window — anything with postMessage + addEventListener.
 * @param {ServePostMessageOptions} [opts]
 * @returns {() => void}  Unsubscribe function.
 */
export function servePostMessage(hermes, endpoint, opts = {}) {
    const { outbound = {}, inbound = {}, targetOrigin = "*", filter } = opts;
    const inboundKeys = Object.keys(inbound);

    if (!hermes || typeof hermes.dispatch !== "function") {
        throw new TypeError("servePostMessage: hermes must have dispatch()");
    }
    if (!endpoint || typeof endpoint.postMessage !== "function" || typeof endpoint.addEventListener !== "function") {
        throw new TypeError("servePostMessage: endpoint must have postMessage() + addEventListener()");
    }

    // Window#postMessage takes (msg, targetOrigin[, transfer]); everything
    // else (worker global, Worker, MessagePort) takes (msg[, transfer]).
    // NOTE: can't reuse the client transport's `"location" in target` probe —
    // worker globals have a WorkerLocation, so it false-positives there.
    // `document` exists only on real Windows.
    const isWindow = (typeof Window !== "undefined" && endpoint instanceof Window) || "document" in endpoint;

    /**
     * @param {any} envelope
     * @param {Transferable[]} transfer
     */
    const reply = (envelope, transfer) => {
        const enveloped = inboundKeys.length === 0 && Object.keys(outbound).length === 0
            ? envelope
            : { ...outbound, ...envelope };
        const hasTransfer = Array.isArray(transfer) && transfer.length > 0;
        if (isWindow) {
            if (hasTransfer) endpoint.postMessage(enveloped, targetOrigin, transfer);
            else endpoint.postMessage(enveloped, targetOrigin);
        } else {
            if (hasTransfer) endpoint.postMessage(enveloped, transfer);
            else endpoint.postMessage(enveloped);
        }
    };

    /** @param {any} event */
    const listener = (event) => {
        const data = event.data;
        if (!data || typeof data !== "object" || typeof data.type !== "string") return;
        // Ignore response envelopes echoing on a shared channel (e.g. a
        // worker global where our own replies also fire 'message' locally
        // in some test harnesses): requests never carry `ok`.
        if ("ok" in data) return;
        for (const k of inboundKeys) {
            if (data[k] !== inbound[k]) return;
        }
        if (filter && !filter(event)) return;

        const msg = inboundKeys.length === 0 ? data : (() => {
            const canonical = { ...data };
            for (const k of inboundKeys) delete canonical[k];
            return canonical;
        })();

        const p = hermes.dispatch(msg, { endpoint, event });
        if (msg.requestId === undefined) return; // fire-and-forget

        p.then((envelope) => {
            reply(envelope, getTransferList(envelope));
        }).catch((err) => {
            // Defensive: HermesHandler.dispatch resolves error envelopes
            // rather than rejecting, but a dispatch-shaped stand-in might not.
            reply({
                ok: false,
                error: `servePostMessage: dispatch rejected (${err instanceof Error ? err.message : String(err)})`,
                requestId: msg.requestId,
            }, []);
        });
    };

    endpoint.addEventListener("message", listener);
    return () => endpoint.removeEventListener("message", listener);
}
