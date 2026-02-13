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
 * @property {any} [details]
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
 * @param {any} x
 * @returns {x is Function}
 */
function isFn(x) {
    return typeof x === "function";
}

/** @param {any} err */
function toErrorString(err) {
    if (err instanceof Error) return err.message || String(err);
    return String(err);
}

/** @param {any} payload */
function normalizePayload(payload) {
    if (payload && typeof payload === "object" && "ok" in payload) {
        // Enforce strict boolean ok
        if (typeof payload.ok !== "boolean") {
            return { ok: false, error: "Invalid response: 'ok' must be boolean" };
        }

        // If ok:false, ensure error exists
        if (payload.ok === false && typeof payload.error !== "string") {
            return { ok: false, error: "Invalid response: missing 'error' string" };
        }

        return payload;
    }

    return { ok: true, result: payload };
}

/** @param {any} payload */
function freezeNormalized(payload) {
    const normalized = normalizePayload(payload);
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
            onUnknown = (msg) => ({ ok: false, error: `Unknown msg.type: ${msg?.type}` }),
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
                    sendResponse(freezeNormalized(this._onError(err, msg, { sender })))
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
            return freezeNormalized({ ok: false, error: "Invalid message: msg expected to be an object" });
        }

        const type = msg.type;

        if (typeof type !== "string" || !type) {
            return freezeNormalized({ ok: false, error: "Invalid message: msg missing string 'type'" });
        }



        let responded = false;

        /** @type {HermesResponse<any>} */
        let payloadToReturn = freezeNormalized({ ok: false, error: "No response" });

        // Cooperative cancellation: handlers MAY honor ctx.signal
        const controller = typeof AbortController !== "undefined"
            ? new AbortController()
            : { signal: undefined, abort: () => { } };

        const ctx = {
            sender,
            tabId: sender?.tab?.id,
            signal: controller.signal,
            send: (/** @type {any} */payload) => {
                if (responded) {
                    this._logger?.warn?.("[Hermes] Multiple send attempts", { type });
                    return;
                }

                responded = true;

                // Freeze to prevent accidental mutation after responding
                // (shallow freeze is enough and avoids surprising perf hits).
                payloadToReturn = freezeNormalized(payload);

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
