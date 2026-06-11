// src/index.d.ts
//
// Public typed surface for the default `hermes-handler` entry. Authored
// directly (vs auto-generated from JSDoc) so the HermesHandler class
// and createHermesClient (re-exported here for convenience) are fully
// generic and end-to-end type-safe in TypeScript consumers.
//
// JavaScript consumers see no difference at runtime; the runtime is
// defined in `src/HermesHandler.js` and `src/client.js` and only
// re-exported here for the type system.

export {
    HermesHandler,
    HermesOk,
    HermesErr,
    HermesResponse,
    HermesMessage,
    HermesContext,
    HermesHandlerFn,
    HermesHandlerConfig,
    HermesHandlerEntry,
    HermesHandlerMap,
    HermesShouldHandleFn,
    HermesLogger,
    HermesOptions,
    HermesMiddleware,
    HermesRequestOf,
    HermesResponseOf,
    Routes,
    HermesClient,
    HermesClientRequest,
    HermesClientTransport,
    CreateHermesClientOptions,
    createHermesClient,
    ClientOf,
    getTransferList,
    setTransferList,
} from "./types.js";
