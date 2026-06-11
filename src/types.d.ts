// src/types.d.ts
//
// Generic type machinery so consumers using TypeScript get end-to-end
// inference from a handler map to its client. Authored as a pure
// declaration file (no runtime); the JS runtime is identical for
// TypeScript and JavaScript consumers.
//
// Usage in a TypeScript project:
//
//   import { HermesHandler, createHermesClient, type ClientOf } from 'hermes-handler';
//   import { postMessageTransport } from 'hermes-handler/transports/postmessage';
//
//   const hermes = new HermesHandler({
//     ping:           (): 'pong' => 'pong',
//     'echo-string':  (msg: { payload: { value: string } }) => msg.payload.value,
//     'admin:wipe':   {
//       timeoutMs: 30000,
//       handler: async (msg: { payload: { confirm: true } }): Promise<{ deleted: number }> =>
//         ({ deleted: await wipe(msg.payload.confirm) }),
//     },
//   });
//
//   type Client = ClientOf<typeof hermes>;
//   const dispatch = createHermesClient<Client>(postMessageTransport(window));
//
//   const r = await dispatch({ type: 'echo-string', payload: { value: 'hi' } });
//   // r is: { ok: true, result: string, info?, requestId? } | { ok: false, error: string, info?, requestId? }
//
//   await dispatch({ type: 'unknown-route' });
//   // ❌ TS2322: Type '"unknown-route"' is not assignable to type ...
//
//   await dispatch({ type: 'ping', payload: { v: 1 } });
//   // ❌ TS error: 'ping' takes no payload

// ============================================================================
// Wire envelopes
// ============================================================================

export type HermesOk<T = unknown> = {
    ok: true;
    result?: T;
    info?: Record<string, unknown>;
    requestId?: string;
};

export type HermesErr = {
    ok: false;
    error: string;
    info?: Record<string, unknown>;
    requestId?: string;
};

export type HermesResponse<T = unknown> = HermesOk<T> | HermesErr;

export type HermesMessage<P = unknown, K extends string = string> = {
    type: K;
    payload?: P;
    requestId?: string;
};

export type HermesContext = {
    sender?: unknown;
    tabId?: number;
    signal: AbortSignal | undefined;
    requestId: string | undefined;
    send: (payload: unknown) => void;
    /**
     * Declare Transferables inside the response that should MOVE to the
     * caller instead of being structured-cloned. Honored by
     * transfer-capable serving glue (`servePostMessage`); readable via
     * `getTransferList(envelope)` for hand-rolled transports. Cumulative
     * across calls within one dispatch.
     */
    transfer: (...transferables: Transferable[]) => void;
};

// ============================================================================
// Handler map & route extraction
// ============================================================================

/** A handler function signature, parameterized over its message and return type. */
export type HermesHandlerFn<M = HermesMessage, R = unknown> = (
    msg: M,
    ctx: HermesContext,
) => R | Promise<R>;

/** Per-handler config block (timeoutMs etc.) — alternative to a bare function. */
export type HermesHandlerConfig<M = HermesMessage, R = unknown> = {
    handler: HermesHandlerFn<M, R>;
    timeoutMs?: number;
};

/** A handler-map entry: bare function or config block. */
export type HermesHandlerEntry<M = HermesMessage, R = unknown> =
    | HermesHandlerFn<M, R>
    | HermesHandlerConfig<M, R>;

/** A complete handler map: string keys → handler entries. */
export type HermesHandlerMap = Record<string, HermesHandlerEntry<any, any>>;

/** Extract the request payload type from a single entry. */
export type HermesRequestOf<E> =
    E extends HermesHandlerFn<infer M, any>
        ? M extends { payload?: infer P } ? P : never
        : E extends HermesHandlerConfig<infer M, any>
            ? M extends { payload?: infer P } ? P : never
            : never;

/** Extract the response (post-Promise-unwrap) type from a single entry. */
export type HermesResponseOf<E> =
    E extends HermesHandlerFn<any, infer R>
        ? Awaited<R>
        : E extends HermesHandlerConfig<any, infer R>
            ? Awaited<R>
            : never;

/** Derive a route table { [type]: { request, response } } from a handler map. */
export type Routes<M extends HermesHandlerMap> = {
    [K in keyof M]: {
        request: HermesRequestOf<M[K]>;
        response: HermesResponseOf<M[K]>;
    };
};

// ============================================================================
// HermesHandler (router) class — generic over handler map
// ============================================================================

export type HermesShouldHandleFn = (msg: unknown, sender: unknown) => boolean;
export type HermesLogger = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
} | null;

export type HermesOptions = {
    timeoutMs?: number;
    onUnknown?: (msg: unknown, ctx: HermesContext) => unknown;
    onError?: (err: unknown, msg: unknown, ctx: HermesContext) => unknown;
    ignoreUnknown?: boolean;
    shouldHandle?: HermesShouldHandleFn;
    logger?: HermesLogger;
};

export type HermesMiddleware = (
    msg: unknown,
    ctx: HermesContext,
    next: () => Promise<HermesResponse<unknown>>,
) => HermesResponse<unknown> | Promise<HermesResponse<unknown>>;

/** Strongly-typed router class. M is inferred from the constructor argument. */
export class HermesHandler<M extends HermesHandlerMap = HermesHandlerMap> {
    constructor(initialHandlers?: M, options?: HermesOptions);

    /** Returns the list of registered message types. */
    types(): Array<keyof M & string>;

    /** Register or overwrite a handler (bare function or config block). */
    register<K extends keyof M & string>(type: K, entry: M[K]): void;

    /** Register multiple handlers at once. */
    registerMany(map: Partial<M>): void;

    /** Remove a handler by type. */
    unregister<K extends keyof M & string>(type: K): void;

    /** Does this router have a handler for the given type? */
    has(type: string): boolean;

    /** Add a middleware to the dispatch chain. Returns `this` for chaining. */
    use(fn: HermesMiddleware): this;

    /** Dispatch a message and resolve with the normalized response. */
    dispatch<K extends keyof M & string>(
        msg: HermesMessage<HermesRequestOf<M[K]>, K>,
        sender?: unknown,
    ): Promise<HermesResponse<HermesResponseOf<M[K]>>>;

    /** Return a chrome.runtime-shaped listener for `onMessage.addListener`. */
    getListener(): (
        msg: unknown,
        sender: unknown,
        sendResponse?: (payload: unknown) => void,
    ) => boolean | Promise<HermesResponse<unknown>>;
}

// ============================================================================
// Client (hermes-handler/client) — generic over the route table
// ============================================================================

export type HermesClientRequest<R, K extends string = string> = {
    type: K;
    payload?: R;
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Transferables inside `payload` to move rather than clone. Forwarded
     * as the transport's second `send` argument; transports over channels
     * that can't transfer ignore it.
     */
    transfer?: Transferable[];
};

export type HermesClientTransport = {
    send: (msg: { type: string; payload?: unknown; requestId: string }, transfer?: Transferable[]) => void;
    subscribe: (handler: (msg: unknown) => void) => () => void;
};

export type CreateHermesClientOptions = HermesClientTransport & {
    defaultTimeoutMs?: number;
    idGen?: () => string;
};

/** A typed client. Callable as `dispatch(req)`; also carries `.on` / `.off` / `.close`. */
export interface HermesClient<R extends Record<string, { request: unknown; response: unknown }>> {
    <K extends keyof R & string>(
        req: HermesClientRequest<R[K]['request'], K>,
    ): Promise<HermesResponse<R[K]['response']>>;

    /** Subscribe to a server-initiated broadcast (no requestId). */
    on(
        type: string,
        handler: (payload: unknown, msg: unknown) => void,
    ): () => void;

    off(
        type: string,
        handler: (payload: unknown, msg: unknown) => void,
    ): void;

    close(): void;
}

export function createHermesClient<
    R extends Record<string, { request: unknown; response: unknown }> = Record<string, { request: unknown; response: unknown }>,
>(opts: CreateHermesClientOptions): HermesClient<R>;

/** Convenience: derive a HermesClient type from a HermesHandler instance. */
export type ClientOf<H> = H extends HermesHandler<infer M> ? HermesClient<Routes<M>> : never;

// ============================================================================
// Transferables (zero-copy postMessage payloads)
// ============================================================================

/**
 * Read the transfer list registered for a response envelope (via
 * `ctx.transfer(...)` in a handler). Returns `[]` when none was
 * registered, so the result can be passed straight to
 * `postMessage(msg, transfer)`. For hand-rolled serving glue;
 * `servePostMessage` calls this internally.
 */
export function getTransferList(envelope: object): Transferable[];

/**
 * Associate a transfer list with a response envelope. Exposed for
 * dispatch-shaped stand-ins that produce envelopes outside
 * HermesHandler; the router itself registers `ctx.transfer(...)`
 * collections automatically.
 */
export function setTransferList(envelope: object, transferables: Transferable[]): void;
