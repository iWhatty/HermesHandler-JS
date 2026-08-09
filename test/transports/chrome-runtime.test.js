import { describe, it, expect } from "vitest";
import { createHermesClient } from "../../src/client.js";
import { chromeRuntimeTransport } from "../../src/transports/chrome-runtime.js";

function makeFakeRuntime() {
    const listeners = new Set();
    return {
        runtime: {
            onMessage: {
                addListener: (fn) => listeners.add(fn),
                removeListener: (fn) => listeners.delete(fn),
            },
            sendMessage: (msg) => {
                // Simulate the runtime callback: feed the message back to all
                // subscribed handlers (which is how chrome.runtime works under
                // promise-returning Manifest V3).
                return Promise.resolve({ ok: true, result: "echo:" + msg.type, requestId: msg.requestId });
            },
        },
        _fanout: (responseLike) => {
            for (const l of listeners) l(responseLike);
        },
        _listenerCount: () => listeners.size,
    };
}

describe("chromeRuntimeTransport", () => {
    it("uses runtime.sendMessage by default and routes responses to subscribers", async () => {
        const runtime = makeFakeRuntime();
        const transport = chromeRuntimeTransport({ runtime });

        const received = [];
        transport.subscribe((msg) => received.push(msg));

        transport.send({ type: "ping", requestId: "r1" });
        await new Promise((r) => setTimeout(r, 0));

        expect(received).toEqual([{ ok: true, result: "echo:ping", requestId: "r1" }]);
    });

    it("uses tabs.sendMessage when tabId is supplied", async () => {
        const sent = [];
        const runtime = {
            runtime: { onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => {} },
            tabs: { sendMessage: (tabId, msg) => { sent.push([tabId, msg]); return Promise.resolve(); } },
        };

        const transport = chromeRuntimeTransport({ tabId: 42, runtime });
        transport.send({ type: "go", requestId: "r" });
        await new Promise((r) => setTimeout(r, 0));

        expect(sent).toEqual([[42, { type: "go", requestId: "r" }]]);
    });

    it.each([
        ["a synchronous throw", () => { throw new Error("runtime unavailable"); }],
        ["a rejected Promise", () => Promise.reject(new Error("no receiving end"))],
    ])("turns %s into a correlated client error envelope", async (_description, sendMessage) => {
        const runtime = {
            runtime: {
                onMessage: { addListener: () => {}, removeListener: () => {} },
                sendMessage,
            },
        };
        const dispatch = createHermesClient({
            ...chromeRuntimeTransport({ runtime }),
            defaultTimeoutMs: 0,
        });

        const response = await dispatch({ type: "ping" });

        expect(response).toMatchObject({
            ok: false,
            error: expect.stringMatching(/send failed/),
            info: { type: "ping" },
        });
    });

    it("does not fan out failures from uncorrelated raw sends", async () => {
        const runtime = {
            runtime: {
                onMessage: { addListener: () => {}, removeListener: () => {} },
                sendMessage: () => Promise.reject(new Error("no receiving end")),
            },
        };
        const transport = chromeRuntimeTransport({ runtime });
        const received = [];
        transport.subscribe((msg) => received.push(msg));

        transport.send({ type: "ping" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(received).toEqual([]);
    });

    it("detaches after the last unsubscribe and reattaches on a later subscription", () => {
        const runtime = makeFakeRuntime();
        const transport = chromeRuntimeTransport({ runtime });
        const first = transport.subscribe(() => {});
        const second = transport.subscribe(() => {});

        expect(runtime._listenerCount()).toBe(1);
        first();
        first();
        expect(runtime._listenerCount()).toBe(1);
        second();
        expect(runtime._listenerCount()).toBe(0);

        const third = transport.subscribe(() => {});
        expect(runtime._listenerCount()).toBe(1);
        third();
        expect(runtime._listenerCount()).toBe(0);
    });

    it("throws when no runtime is available", () => {
        expect(() => chromeRuntimeTransport({ runtime: null })).toThrow(/runtime/);
    });
});
