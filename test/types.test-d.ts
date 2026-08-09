// test/types.test-d.ts
//
// TypeScript inference smoke test. Not run by vitest — instead, the
// `test:types` script (added in 1.0.0) runs `tsc --noEmit` on this file
// to verify the type machinery works end-to-end. Compilation success is
// the assertion.

import {
    HermesHandler,
    createHermesClient,
    type ClientOf,
    type HermesResponse,
    type HermesClient,
    type Routes,
} from "../src/index.js";

// ============================================================================
// Handler map shape inference
// ============================================================================

const hermes = new HermesHandler({
    ping: (): "pong" => "pong",
    "echo-string": (msg: { payload: { value: string } }): string => msg.payload.value,
    "make-num": async (msg: { payload: { n: number } }): Promise<{ doubled: number }> =>
        ({ doubled: msg.payload.n * 2 }),
    "admin:wipe": {
        timeoutMs: 30000,
        handler: async (_msg: { payload: { confirm: true } }): Promise<{ deleted: number }> =>
            ({ deleted: 0 }),
    },
});

type H = typeof hermes;
type Client = ClientOf<H>;

// ============================================================================
// dispatch (server-side direct call) — typed by handler map
// ============================================================================

async function checkDispatch() {
    // Known type, no payload required
    const r1 = await hermes.dispatch({ type: "ping" });
    // Response type narrows: HermesResponse<"pong">
    if (r1.ok) {
        const _result: "pong" = r1.result!;
        void _result;
    }

    // Known type with payload
    const r2 = await hermes.dispatch({ type: "echo-string", payload: { value: "x" } });
    if (r2.ok) {
        const _result: string = r2.result!;
        void _result;
    }

    // @ts-expect-error — 'unknown-route' is not a registered type
    await hermes.dispatch({ type: "unknown-route" });

    // @ts-expect-error — 'ping' takes no payload (type narrowing)
    await hermes.dispatch({ type: "ping", payload: { v: 1 } });
}
void checkDispatch;

// ============================================================================
// createHermesClient<Client> — typed dispatch + on
// ============================================================================

async function checkClient() {
    const transport = {
        send: (_msg: any) => { /* test stub */ },
        subscribe: (_handler: (msg: any) => void) => () => { /* unsub */ },
    };
    // ClientOf<typeof hermes> — derives the route table from the handler
    // map automatically. Use the explicit Client alias to verify.
    const dispatch = createHermesClient<Client extends HermesClient<infer R> ? R : never>(transport);

    // Known type with correct payload — response typed
    const r1 = await dispatch({ type: "make-num", payload: { n: 4 } });
    if (r1.ok) {
        const _doubled: number = r1.result!.doubled;
        void _doubled;
    }

    // .on returns an unsubscribe function
    const unsub: () => void = dispatch.on("any-event", (payload, msg) => {
        void payload;
        void msg;
    });
    unsub();
    dispatch.close();
}
void checkClient;

// ============================================================================
// Routes<M> extraction
// ============================================================================

type _Routes = Routes<{
    foo: (msg: { payload: { x: number } }) => { y: string };
    bar: { handler: (msg: { payload: { p: boolean } }) => Promise<{ q: number }>; timeoutMs: 1000 };
}>;
// _Routes['foo'] should be { request: { x: number }, response: { y: string } }
// _Routes['bar'] should be { request: { p: boolean }, response: { q: number } }
const _fooReq: _Routes["foo"]["request"] = { x: 1 };
const _fooRes: _Routes["foo"]["response"] = { y: "z" };
const _barReq: _Routes["bar"]["request"] = { p: true };
const _barRes: _Routes["bar"]["response"] = { q: 2 };
void _fooReq; void _fooRes; void _barReq; void _barRes;

// ============================================================================
// HermesResponse discriminated union narrows
// ============================================================================

function checkUnionNarrowing(r: HermesResponse<{ data: string }>) {
    if (r.ok) {
        // result is the success type
        const _result: { data: string } | undefined = r.result;
        void _result;
        // @ts-expect-error — error doesn't exist on the success branch
        void r.error;
    } else {
        // error is always a string on the failure branch
        const _err: string = r.error;
        void _err;
        // @ts-expect-error — result doesn't exist on the failure branch
        void r.result;
    }
}
void checkUnionNarrowing;
