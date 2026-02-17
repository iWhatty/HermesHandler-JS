// src/HermesHandler.js

// ------------------------------------------------------------
// HermesHandler  — universal message router / gatekeeper
// ------------------------------------------------------------



/**
 * @template T
 * @typedef {Object} HermesOk
 * @property {true} ok
 * @property {T} [result]
 */


/**
 * @typedef {Object} HermesErr
 * @property {false} ok
 * @property {string} error
 * @property {any} [info]
 */


/**
 * @template T
 * @typedef {HermesOk<T> | HermesErr} HermesResponse
 */


/**
 * @typedef {Object} HermesMessage
 * @property {string} type
 * @property {any} [payload]
 * @property {string} [requestId]  // optional correlation id
 */


/**
 * @typedef {Object} HermesContext
 * @property {any} sender
 * @property {number|undefined} tabId
 * @property {AbortSignal|undefined} signal
 * @property {string|undefined} requestId
 * @property {(payload: any) => void} send
 */


/**
 * @callback HermesHandlerFn
 * @param {HermesMessage} msg
 * @param {HermesContext} ctx
 * @returns {HermesResponse<any>|Promise<HermesResponse<any>>|any}
 */


/**
 * @typedef {Object} HermesLogger
 * @property {(message?: any, ...optionalParams: any[]) => void} [debug]
 * @property {(message?: any, ...optionalParams: any[]) => void} [info]
 * @property {(message?: any, ...optionalParams: any[]) => void} [warn]
 * @property {(message?: any, ...optionalParams: any[]) => void} [error]
 */



/* ------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------- */

/**
 * Type guard for callable values.
 *
 * @param {unknown} value
 * @returns {value is (...args: any[]) => any}
 */
function isFn(value) {
    return typeof value === "function";
}

/**
 * Convert unknown error-like values into a readable string.
 *
 * @param {unknown} err
 * @returns {string}
 */
function toErrorString(err) {
    if (err instanceof Error) {
        return err.message || String(err);
    }

    if (err && typeof err === "object" && "message" in err) {
        const msg = /** @type {{ message?: unknown }} */ (err).message;
        if (typeof msg === "string") return msg;
    }

    return String(err);
}


const HERMES_KEYS = new Set(["ok", "result", "error", "info"]);
const HERMES_KEYS_SUCCESS = new Set(["ok", "result", "info"]);
const HERMES_KEYS_ERROR = new Set(["ok", "error", "info"]);

/**
 * Collect non-canonical fields into an `info` bag.
 *
 * @param {any} payload
 * @param {ReadonlySet<string> | readonly string[]} skipKeys
 * @returns {Record<string, any> | null}
 */
function collectInfo(payload, skipKeys) {
    const skip = skipKeys instanceof Set ? skipKeys : new Set(skipKeys);

    /** @type {Record<string, any> | null} */
    let info = null;

    /** @param {string} k @param {any} v */
    const addInfo = (k, v) => {
        if (v === undefined) return;
        if (info === null) info = {};
        info[k] = v;
    };

    if ("info" in payload) addInfo("handlerInfo", payload.info);

    for (const [k, v] of Object.entries(payload)) {
        if (skip.has(k)) continue;
        addInfo(k, v);
    }

    return info;
}


/**
 * Normalize any handler return value into a HermesResponse.
 *
 * Goals:
 *  - Always return a deterministic envelope: {ok:true,result?} or {ok:false,error,info?}
 *  - Never silently drop useful info: preserve conflicting/extra fields in info and warn
 *
 * @param {any} payload
 * @param {HermesLogger|null} logger
 * @returns {{ ok: true, result?: any, info?: any } | { ok: false, error: string, info?: any }}
 */
function normalizePayload(payload, logger = null) {
    if (!payload || typeof payload !== "object" || !("ok" in payload)) {
        return { ok: true, result: payload };
    }

    if (typeof payload.ok !== "boolean") {
        return { ok: false, error: "Invalid response: 'ok' must be boolean" };
    }

    if (payload.ok === false) {
        if (typeof payload.error !== "string") {
            return { ok: false, error: "Invalid response: missing 'error' string" };
        }

        // Extras include accidental result + any unexpected keys + handlerInfo
        const info = collectInfo(payload, HERMES_KEYS_ERROR) /* includes result + others */;

        if (info) {
            logger?.warn?.("[Hermes] ok:false response contained extra fields; preserved in info", {
                extraKeys: Object.keys(info)
            });
            return { ok: false, error: payload.error, info };
        }

        return { ok: false, error: payload.error };
    }

    /** @type {{ ok: true, result?: any, info?: any }} */
    const out = { ok: true };
    if ("result" in payload) out.result = payload.result;

    // Extras include accidental error + any unexpected keys + handlerInfo
    const info = collectInfo(payload, HERMES_KEYS_SUCCESS) /* includes error + others */;

    if (info) {
        logger?.warn?.("[Hermes] ok:true response contained extra fields; preserved in info", {
            extraKeys: Object.keys(info)
        });
        out.info = info;
    }

    return out;
}

/**
 * @param {any} payload
 * @param {HermesLogger|null} logger
 */
function freezeNormalized(payload, logger = null) {
    const normalized = normalizePayload(payload, logger);
    return normalized && typeof normalized === "object"
        ? Object.freeze(normalized)
        : normalized;
}


/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} ms
 * @param {() => any} onTimeout
 * @returns {Promise<T>}
 */
function withTimeout(fn, ms, onTimeout) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return Promise.resolve().then(fn);
    }

    const makeTimeoutError = () => {
        try {
            return onTimeout();
        } catch (e) {
            return e;
        }
    };

    return new Promise((resolve, reject) => {

        /** @type {ReturnType<typeof setTimeout>} */
        let timerId;

        const cleanup = () => clearTimeout(timerId);

        /** @param {T} value */
        const resolveWithCleanup = (value) => {
            cleanup();
            resolve(value);
        };

        /** @param {any} err */
        const rejectWithCleanup = (err) => {
            cleanup();
            reject(err);
        };

        timerId = setTimeout(() => rejectWithCleanup(makeTimeoutError()), ms);

        Promise.resolve()
            .then(fn)
            .then(resolveWithCleanup)
            .catch(rejectWithCleanup);
    });
}


export class HermesHandler {
    /**
     * @param {Record<string, HermesHandlerFn>} initialHandlers
     * @param {Object} [options]
     * @param {number} [options.timeoutMs=5000]  max time a handler can take before auto-fail
     * @param {(msg: any, ctx: any) => any} [options.onUnknown]  override unknown-type response
     * @param {(err: any, msg: any, ctx: any) => any} [options.onError] override error response
     * @param {HermesLogger|null} [options.logger=console]  set to null to silence logs
     */
    constructor(initialHandlers = {}, options = {}) {
        const {
            timeoutMs = 5000,
            onUnknown = (msg, _ctx) => ({ ok: false, error: `Unknown msg.type: ${msg?.type}` }),
            onError = (err) => ({ ok: false, error: toErrorString(err) }),
            logger = console
        } = options;

        /** @type {Map<string, HermesHandlerFn>} */
        this._handlers = new Map(Object.entries(initialHandlers));
        this._timeoutMs = timeoutMs;
        this._onUnknown = onUnknown;
        this._onError = onError;

        /** @type {HermesLogger|null} */
        this._logger = logger;
    }


    /**
     * Get a list of currently registered message types.
     *
     * The returned array reflects registration order (Map insertion order).
     * Useful for debugging, diagnostics, or validating integration boundaries.
     *
     * @returns {string[]} Array of registered message type strings.
     */
    types() {
        return [...this._handlers.keys()];
    }


    /**
     * Register (or overwrite) a handler for a given msg.type
     * @param {string} type
     * @param {HermesHandlerFn} fn
     * @returns {void}
     */
    register(type, fn) {
        if (!isFn(fn)) {
            throw new Error(`Handler for ${type} must be a function`);
        }
        this._handlers.set(type, fn);
    }

    /**
     * Register multiple handlers at once
     * @param {Record<string, HermesHandlerFn>} map
     * @returns {void}
     */
    registerMany(map) {
        for (const [type, fn] of Object.entries(map ?? {})) {
            this.register(type, fn);
        }
    }

    /** Remove a handler for a given msg.type */
    /** @param {string} type */
    unregister(type) {
        this._handlers.delete(type);
    }

    /** Check if a handler exists for a given msg.type */
    /** @param {string} type */
    has(type) {
        return this._handlers.has(type);
    }


    /**
    * The listener you add using browser.runtime.onMessage.addListener
    *
    * Supports BOTH reply styles:
    * • Promise-returning listener (Firefox / MV3 / polyfill)
    * • sendResponse + return true (callback-style)
    * @returns {(msg: any, sender: any, sendResponse?: (payload: any) => void) => any}
    */
    getListener() {
        return (msg, sender, sendResponse) => {
            const p = this._dispatch(msg, sender);


            // Callback-style (works everywhere)
            if (isFn(sendResponse)) {

                p.then(sendResponse).catch((err) =>
                    sendResponse(
                        freezeNormalized(
                            this._onError(err, msg, { sender, tabId: sender?.tab?.id }),
                            this._logger
                        )
                    )
                );

                return true; // keep the port open for async response
            }




            // Promise-returning style
            return p;
        };
    }

    // ---- Core dispatch ------------------------------------------------------
    /**
     * @param {any} msg
     * @param {any} sender
     * @returns {Promise<HermesResponse<any>>}
     */
    async _dispatch(msg, sender) {

        if (!msg || typeof msg !== "object") {
            return freezeNormalized({ ok: false, error: "Invalid message: msg expected to be an object" }, this._logger);
        }

        const type = msg.type;

        if (typeof type !== "string" || !type) {
            return freezeNormalized({ ok: false, error: "Invalid message: msg missing string 'type'" }, this._logger);
        }



        let responded = false;

        /** @type {HermesResponse<any>} */
        let payloadToReturn = freezeNormalized({ ok: false, error: "No response" }, this._logger);


        // Cooperative cancellation: handlers MAY honor ctx.signal
        const controller = typeof AbortController !== "undefined"
            ? new AbortController()
            : { signal: undefined, abort: () => { } };

        const ctx = {
            sender,
            tabId: sender?.tab?.id,
            signal: controller.signal,
            requestId: msg?.requestId,
            send: (/** @type {any} */payload) => {
                if (responded) {
                    this._logger?.warn?.("[Hermes] Multiple send attempts", { type });
                    return;
                }

                responded = true;

                // Freeze to prevent accidental mutation after responding
                // (shallow freeze is enough and avoids surprising perf hits).
                payloadToReturn = freezeNormalized(payload, this._logger);

            }

        };

        const fn = this._handlers.get(type);

        if (!fn) {
            ctx.send(this._onUnknown(msg, ctx));
            return payloadToReturn;
        }

        try {
            const maybeReturn = await withTimeout(
                () => fn(msg, ctx),
                this._timeoutMs,
                () => new Error(`Handler ${type} timed out (${this._timeoutMs} ms)`)
            );

            // Handler may either return a payload OR call ctx.send(payload)
            if (!responded && maybeReturn !== undefined) {
                ctx.send(maybeReturn);
            }

            if (!responded) {
                ctx.send({ ok: false, error: `Handler ${type} returned no response` });
            }
        } catch (err) {
            this._logger?.error?.(`[Hermes] Handler error for ${type}:`, err);
            if (!responded) {
                ctx.send(this._onError(err, msg, ctx));
            }
        } finally {
            // NOTE: Abort does not stop JS execution, but lets handlers cooperate.
            controller.abort();
        }

        return payloadToReturn;
    }


    /**
     * Dispatch a message through the router (useful for testing / non-runtime environments).
     * @param {HermesMessage} msg
     * @param {any} [sender]
     * @returns {Promise<HermesResponse<any>>}
     */
    dispatch(msg, sender) {
        return this._dispatch(msg, sender);
    }



}
