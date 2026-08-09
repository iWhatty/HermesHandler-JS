import { describe, it, expect, vi } from "vitest";
import { createHermesClient } from "../src/client.js";
import { HermesHandler } from "../src/HermesHandler.js";

/**
 * Spin up an in-process loopback transport: client.send pushes a request
 * into the server, the server responds back through a subscriber queue.
 * This is the same wire shape the postMessage / chrome.runtime callers use.
 */
function loopback(handlers, opts) {
    const subscribers = new Set();

    const server = new HermesHandler(handlers, opts);

    const send = (msg) => {
        // Dispatch into the server and post the response back to subscribers.
        // Server is async; don't await — clients aren't synchronous either.
        server.dispatch(msg).then((res) => {
            const wire = { ...res, requestId: msg.requestId };
            for (const handler of subscribers) handler(wire);
        });
    };

    const subscribe = (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
    };

    return { send, subscribe, server };
}

describe("createHermesClient", () => {
    it("resolves with an ok envelope on a successful round-trip", async () => {
        const { send, subscribe } = loopback({
            ping: () => "pong",
        });
        const dispatch = createHermesClient({ send, subscribe });

        const res = await dispatch({ type: "ping" });

        expect(res).toEqual({ ok: true, result: "pong" });
    });

    // The next two tests exercise the *client* in isolation against a
    // controlled wire emission. Server-side normalization is covered in the
    // router tests; the client just forwards whatever envelope the wire carries.

    it("preserves info on a success envelope", async () => {
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send: (msg) => {
                for (const h of subscribers) {
                    h({ ok: true, result: 42, info: { hits: 3 }, requestId: msg.requestId });
                }
            },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
        });

        const res = await dispatch({ type: "stats" });

        expect(res).toEqual({ ok: true, result: 42, info: { hits: 3 } });
    });

    it("forwards an error envelope when the wire carries ok:false", async () => {
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send: (msg) => {
                for (const h of subscribers) {
                    h({ ok: false, error: "kaboom", info: { code: 7 }, requestId: msg.requestId });
                }
            },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
        });

        const res = await dispatch({ type: "boom" });

        expect(res).toEqual({ ok: false, error: "kaboom", info: { code: 7 } });
    });

    it("integrates cleanly with a real HermesHandler server preserving canonical error info", async () => {
        const { send, subscribe } = loopback({
            boom: () => ({ ok: false, error: "kaboom", info: { code: 7 } }),
        });
        const dispatch = createHermesClient({ send, subscribe });

        const res = await dispatch({ type: "boom" });

        expect(res).toEqual({ ok: false, error: "kaboom", info: { code: 7 } });
    });

    it("filters responses by requestId — concurrent calls don't cross-contaminate", async () => {
        const { send, subscribe } = loopback({
            echo: (msg) => msg.payload,
        });
        const dispatch = createHermesClient({ send, subscribe });

        const [a, b] = await Promise.all([
            dispatch({ type: "echo", payload: "first" }),
            dispatch({ type: "echo", payload: "second" }),
        ]);

        expect(a).toEqual({ ok: true, result: "first" });
        expect(b).toEqual({ ok: true, result: "second" });
    });

    it("times out per the defaultTimeoutMs option", async () => {
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send: () => { /* never replies */ },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
            defaultTimeoutMs: 30,
        });

        const res = await dispatch({ type: "hang" });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/timeout/i);
        expect(res.info?.timeout).toBe(true);
    });

    it("per-call timeoutMs overrides the default", async () => {
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send: () => { /* never replies */ },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
            defaultTimeoutMs: 5000,
        });

        const start = Date.now();
        const res = await dispatch({ type: "hang", timeoutMs: 25 });
        const elapsed = Date.now() - start;

        expect(res.ok).toBe(false);
        expect(elapsed).toBeLessThan(500);
    });

    it("timeoutMs:0 disables the client-side timeout", async () => {
        const { send, subscribe } = loopback({
            slow: async () => {
                await new Promise((r) => setTimeout(r, 50));
                return "done";
            },
        });
        const dispatch = createHermesClient({ send, subscribe, defaultTimeoutMs: 10 });

        const res = await dispatch({ type: "slow", timeoutMs: 0 });

        expect(res).toEqual({ ok: true, result: "done" });
    });

    it("AbortSignal cancels an in-flight dispatch", async () => {
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send: () => { /* never replies */ },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
            defaultTimeoutMs: 0,
        });

        const ctrl = new AbortController();
        const promise = dispatch({ type: "hang", signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 10);

        const res = await promise;

        expect(res.ok).toBe(false);
        expect(res.error).toBe("Aborted");
        expect(res.info?.aborted).toBe(true);
    });

    it("AbortSignal that is already aborted resolves immediately", async () => {
        const dispatch = createHermesClient({
            send: vi.fn(),
            subscribe: () => () => { },
        });

        const ctrl = new AbortController();
        ctrl.abort();

        const res = await dispatch({ type: "hang", signal: ctrl.signal });

        expect(res.ok).toBe(false);
        expect(res.error).toBe("Aborted");
    });

    it("a throwing send resolves the dispatch with an error envelope", async () => {
        const dispatch = createHermesClient({
            send: () => { throw new Error("transport blew up"); },
            subscribe: () => () => { },
            defaultTimeoutMs: 0,
        });

        const res = await dispatch({ type: "echo" });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/transport blew up/);
    });

    it("rejects an empty type with a clear error envelope", async () => {
        const dispatch = createHermesClient({
            send: vi.fn(),
            subscribe: () => () => { },
        });

        const res = await dispatch({ type: "" });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/non-empty string/i);
    });

    it("uses a custom idGen when provided", async () => {
        const seen = [];
        const subscribers = new Set();
        let nextId = 1000;

        const dispatch = createHermesClient({
            send: (msg) => {
                seen.push(msg.requestId);
                // echo
                const wire = { ok: true, result: msg.payload, requestId: msg.requestId };
                for (const h of subscribers) h(wire);
            },
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
            idGen: () => `custom-${nextId++}`,
        });

        await dispatch({ type: "echo", payload: 1 });
        await dispatch({ type: "echo", payload: 2 });

        expect(seen).toEqual(["custom-1000", "custom-1001"]);
    });

    it("fails safely when idGen returns an invalid requestId", async () => {
        const send = vi.fn();
        const dispatch = createHermesClient({
            send,
            subscribe: () => () => {},
            idGen: () => "",
        });

        await expect(dispatch({ type: "echo" })).resolves.toEqual({
            ok: false,
            error: "Hermes client: idGen must return a non-empty string",
            info: { type: "echo" },
        });
        expect(send).not.toHaveBeenCalled();
    });

    it("does not overwrite a pending dispatch when idGen returns a duplicate ID", async () => {
        const subscribers = new Set();
        const send = vi.fn();
        const dispatch = createHermesClient({
            send,
            subscribe: (handler) => {
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            },
            idGen: () => "same-id",
            defaultTimeoutMs: 0,
        });

        const first = dispatch({ type: "first" });
        const second = await dispatch({ type: "second" });

        expect(second).toEqual({
            ok: false,
            error: "Hermes client: duplicate requestId",
            info: { requestId: "same-id", type: "second" },
        });
        expect(send).toHaveBeenCalledTimes(1);

        for (const handler of subscribers) handler({ ok: true, result: "first", requestId: "same-id" });
        await expect(first).resolves.toEqual({ ok: true, result: "first" });
    });

    it("throws synchronously on factory misuse", () => {
        expect(() => createHermesClient({ subscribe: () => () => { } })).toThrow(/send/);
        expect(() => createHermesClient({ send: () => { } })).toThrow(/subscribe/);
    });

    // ------------------------------------------------------------
    // Pub/sub channel (.on / .off / broadcast routing)
    // ------------------------------------------------------------

    describe("pub/sub channel", () => {
        function makeFanout() {
            const subscribers = new Set();
            return {
                send: () => { /* not used in these tests */ },
                subscribe: (handler) => {
                    subscribers.add(handler);
                    return () => subscribers.delete(handler);
                },
                emit(wire) {
                    for (const h of subscribers) h(wire);
                },
            };
        }

        it("routes broadcasts (no requestId) to .on() subscribers by type", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);

            const fps = [];
            const css = [];
            dispatch.on("fps", (payload) => fps.push(payload));
            dispatch.on("css", (payload) => css.push(payload));

            transport.emit({ type: "fps", payload: { v: 60 } });
            transport.emit({ type: "css", payload: { selector: "#x" } });
            transport.emit({ type: "fps", payload: { v: 30 } });

            expect(fps).toEqual([{ v: 60 }, { v: 30 }]);
            expect(css).toEqual([{ selector: "#x" }]);
        });

        it("ignores broadcasts for unsubscribed types silently", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);
            expect(() => transport.emit({ type: "unrelated", payload: 1 })).not.toThrow();
        });

        it("returns an unsubscribe function from .on()", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);

            const seen = [];
            const off = dispatch.on("evt", (p) => seen.push(p));
            transport.emit({ type: "evt", payload: 1 });
            off();
            transport.emit({ type: "evt", payload: 2 });

            expect(seen).toEqual([1]);
        });

        it("supports multiple subscribers per type and fans out", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);

            const a = [];
            const b = [];
            dispatch.on("evt", (p) => a.push(p));
            dispatch.on("evt", (p) => b.push(p));
            transport.emit({ type: "evt", payload: 1 });
            transport.emit({ type: "evt", payload: 2 });

            expect(a).toEqual([1, 2]);
            expect(b).toEqual([1, 2]);
        });

        it("isolates one handler's throw from others", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);
            const seen = [];
            dispatch.on("evt", () => { throw new Error("boom"); });
            dispatch.on("evt", (p) => seen.push(p));
            transport.emit({ type: "evt", payload: 1 });
            expect(seen).toEqual([1]);
        });

        it(".off(type, handler) removes a specific subscriber", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);
            const seen = [];
            const handler = (p) => seen.push(p);
            dispatch.on("evt", handler);
            transport.emit({ type: "evt", payload: 1 });
            dispatch.off("evt", handler);
            transport.emit({ type: "evt", payload: 2 });
            expect(seen).toEqual([1]);
        });

        it("dispatch responses with requestId are routed to pending dispatches, NOT broadcast handlers", async () => {
            // Even if a broadcast handler is registered for the same `type`,
            // a message with a matching requestId routes to dispatch.
            const subscribers = new Set();
            let serverReplyTo;
            const server = new HermesHandler({ ping: () => "pong" });
            const transport = {
                send: (msg) => {
                    server.dispatch(msg).then((res) => {
                        for (const h of subscribers) h(res);
                    });
                },
                subscribe: (handler) => {
                    subscribers.add(handler);
                    return () => subscribers.delete(handler);
                },
            };
            const dispatch = createHermesClient(transport);

            const broadcasts = [];
            dispatch.on("ping", (p) => broadcasts.push(p));

            const res = await dispatch({ type: "ping" });
            expect(res).toEqual({ ok: true, result: "pong" });
            // Broadcast handler should NOT fire — the response had a requestId.
            expect(broadcasts).toEqual([]);
        });

        it("broadcasts and dispatch responses coexist on the same transport", async () => {
            const subscribers = new Set();
            const server = new HermesHandler({ ping: () => "pong" });
            const transport = {
                send: (msg) => {
                    server.dispatch(msg).then((res) => {
                        for (const h of subscribers) h(res);
                    });
                },
                subscribe: (handler) => {
                    subscribers.add(handler);
                    return () => subscribers.delete(handler);
                },
            };
            const dispatch = createHermesClient(transport);

            const seen = [];
            dispatch.on("server-push", (p) => seen.push(p));

            // Simulate a server-initiated broadcast hitting the same subscribers.
            for (const h of subscribers) h({ type: "server-push", payload: { tick: 1 } });
            const res = await dispatch({ type: "ping" });
            for (const h of subscribers) h({ type: "server-push", payload: { tick: 2 } });

            expect(res).toEqual({ ok: true, result: "pong" });
            expect(seen).toEqual([{ tick: 1 }, { tick: 2 }]);
        });

        it(".close() unsubscribes from the transport only once", () => {
            let unsubscribeCalls = 0;
            const transport = {
                send: () => {},
                subscribe: () => () => { unsubscribeCalls += 1; },
            };
            const dispatch = createHermesClient(transport);
            dispatch.close();
            dispatch.close();
            expect(unsubscribeCalls).toBe(1);
        });

        it(".close() settles timeout-disabled dispatches and blocks future sends", async () => {
            const send = vi.fn();
            const dispatch = createHermesClient({
                send,
                subscribe: () => () => {},
                defaultTimeoutMs: 0,
            });

            const pending = dispatch({ type: "hang" });
            dispatch.close();

            await expect(pending).resolves.toEqual({
                ok: false,
                error: "Hermes client: client is closed",
                info: expect.objectContaining({ closed: true, type: "hang" }),
            });
            await expect(dispatch({ type: "after-close" })).resolves.toEqual({
                ok: false,
                error: "Hermes client: client is closed",
                info: { closed: true },
            });
            expect(send).toHaveBeenCalledTimes(1);
        });

        it(".on() is a no-op after close while preserving its unsubscribe contract", () => {
            const transport = makeFanout();
            const dispatch = createHermesClient(transport);
            const seen = [];

            dispatch.close();
            const off = dispatch.on("evt", (payload) => seen.push(payload));
            transport.emit({ type: "evt", payload: 1 });
            off();

            expect(seen).toEqual([]);
        });

        it(".on() rejects malformed args", () => {
            const dispatch = createHermesClient({ send: () => {}, subscribe: () => () => {} });
            expect(() => dispatch.on("", () => {})).toThrow(/non-empty/);
            expect(() => dispatch.on("evt", null)).toThrow(/must be a function/);
        });
    });
});
