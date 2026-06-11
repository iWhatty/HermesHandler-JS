import { describe, it, expect, vi } from "vitest";
import { createHermesClient } from "../src/client.js";
import { HermesHandler } from "../src/HermesHandler.js";
import { getTransferList, setTransferList } from "../src/internal/transfer.js";
import { postMessageTransport, servePostMessage } from "../src/transports/postmessage.js";

/**
 * Minimal postMessage-shaped endpoint pair, MessageChannel-style: what one
 * side posts, the other side's 'message' listeners receive (async, like a
 * real port). Captures transfer lists so tests can assert zero-copy intent
 * without a DOM.
 */
function endpointPair() {
    const make = () => ({
        listeners: new Set(),
        posted: [],
        peer: null,
        postMessage(msg, transfer) {
            this.posted.push({ msg, transfer });
            queueMicrotask(() => {
                for (const l of this.peer.listeners) l({ data: msg });
            });
        },
        addEventListener(_type, l) { this.listeners.add(l); },
        removeEventListener(_type, l) { this.listeners.delete(l); },
    });
    const a = make();
    const b = make();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

describe("transfer registry (internal/transfer.js)", () => {
    it("round-trips a transfer list keyed by envelope identity", () => {
        const envelope = Object.freeze({ ok: true, result: 1 });
        const buf = new ArrayBuffer(8);
        setTransferList(envelope, [buf]);
        expect(getTransferList(envelope)).toEqual([buf]);
    });

    it("returns [] for envelopes with no registered list", () => {
        expect(getTransferList({ ok: true })).toEqual([]);
        expect(getTransferList(null)).toEqual([]);
        expect(getTransferList(undefined)).toEqual([]);
    });

    it("ignores empty or non-array lists", () => {
        const envelope = { ok: true };
        setTransferList(envelope, []);
        setTransferList(envelope, "nope");
        expect(getTransferList(envelope)).toEqual([]);
    });
});

describe("client request transfer", () => {
    it("forwards request.transfer as send's second argument", async () => {
        const buf = new ArrayBuffer(16);
        const send = vi.fn((msg) => {
            for (const h of subscribers) h({ ok: true, requestId: msg.requestId });
        });
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send,
            subscribe: (h) => { subscribers.add(h); return () => subscribers.delete(h); },
        });

        await dispatch({ type: "op", payload: { data: buf }, transfer: [buf] });

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][1]).toEqual([buf]);
    });

    it("passes undefined transfer when the request has none", async () => {
        const send = vi.fn((msg) => {
            for (const h of subscribers) h({ ok: true, requestId: msg.requestId });
        });
        const subscribers = new Set();
        const dispatch = createHermesClient({
            send,
            subscribe: (h) => { subscribers.add(h); return () => subscribers.delete(h); },
        });

        await dispatch({ type: "op" });

        expect(send.mock.calls[0][1]).toBeUndefined();
    });
});

describe("postMessageTransport transfer forwarding", () => {
    it("passes the transfer list to a port-style target", () => {
        const [port] = endpointPair();
        const transport = postMessageTransport(port);
        const buf = new ArrayBuffer(8);

        transport.send({ type: "op", requestId: "r1" }, [buf]);

        expect(port.posted[0].transfer).toEqual([buf]);
    });

    it("omits the transfer argument when the list is empty or absent", () => {
        const [port] = endpointPair();
        const transport = postMessageTransport(port);

        transport.send({ type: "a", requestId: "r1" });
        transport.send({ type: "b", requestId: "r2" }, []);

        expect(port.posted[0].transfer).toBeUndefined();
        expect(port.posted[1].transfer).toBeUndefined();
    });
});

describe("ctx.transfer (router)", () => {
    it("registers handler-declared transferables against the response envelope", async () => {
        const buf = new ArrayBuffer(32);
        const hermes = new HermesHandler({
            compute: (_msg, ctx) => {
                ctx.transfer(buf);
                return { ok: true, result: { data: buf } };
            },
        }, { logger: null });

        const res = await hermes.dispatch({ type: "compute", requestId: "r1" });

        expect(res.ok).toBe(true);
        expect(getTransferList(res)).toEqual([buf]);
    });

    it("accumulates across multiple calls and skips null/undefined", async () => {
        const a = new ArrayBuffer(1);
        const b = new ArrayBuffer(2);
        const hermes = new HermesHandler({
            compute: (_msg, ctx) => {
                ctx.transfer(a);
                ctx.transfer(null, b, undefined);
                return 1;
            },
        }, { logger: null });

        const res = await hermes.dispatch({ type: "compute", requestId: "r1" });

        expect(getTransferList(res)).toEqual([a, b]);
    });

    it("leaves envelopes without ctx.transfer unregistered", async () => {
        const hermes = new HermesHandler({ plain: () => 1 }, { logger: null });
        const res = await hermes.dispatch({ type: "plain", requestId: "r1" });
        expect(getTransferList(res)).toEqual([]);
    });
});

describe("servePostMessage", () => {
    it("serves a full client round-trip over an endpoint pair", async () => {
        const [serverPort, clientPort] = endpointPair();
        const hermes = new HermesHandler({
            double: (msg) => msg.payload.value * 2,
        }, { logger: null });
        const stop = servePostMessage(hermes, serverPort);
        const dispatch = createHermesClient(postMessageTransport(clientPort));

        const res = await dispatch({ type: "double", payload: { value: 21 } });

        expect(res).toEqual({ ok: true, result: 42 });
        stop();
    });

    it("replies with the handler's transfer list", async () => {
        const [serverPort, clientPort] = endpointPair();
        const out = new ArrayBuffer(64);
        const hermes = new HermesHandler({
            render: (_msg, ctx) => {
                ctx.transfer(out);
                return { ok: true, result: { data: out } };
            },
        }, { logger: null });
        servePostMessage(hermes, serverPort);
        const dispatch = createHermesClient(postMessageTransport(clientPort));

        const res = await dispatch({ type: "render" });

        expect(res.ok).toBe(true);
        expect(serverPort.posted[0].transfer).toEqual([out]);
    });

    it("does not reply to fire-and-forget messages (no requestId)", async () => {
        const [serverPort, clientPort] = endpointPair();
        const seen = vi.fn();
        const hermes = new HermesHandler({ note: (msg) => { seen(msg.payload); return 1; } }, { logger: null });
        servePostMessage(hermes, serverPort);

        clientPort.postMessage({ type: "note", payload: "hi" });
        await new Promise((r) => setTimeout(r, 10));

        expect(seen).toHaveBeenCalledWith("hi");
        expect(serverPort.posted).toEqual([]);
    });

    it("ignores inbound messages that fail the discriminator", async () => {
        const [serverPort, clientPort] = endpointPair();
        const hermes = new HermesHandler({ op: () => 1 }, { logger: null });
        servePostMessage(hermes, serverPort, { inbound: { source: "app" } });

        clientPort.postMessage({ type: "op", requestId: "r1" });
        await new Promise((r) => setTimeout(r, 10));
        expect(serverPort.posted).toEqual([]);

        clientPort.postMessage({ type: "op", requestId: "r2", source: "app" });
        await new Promise((r) => setTimeout(r, 10));
        expect(serverPort.posted.length).toBe(1);
        expect(serverPort.posted[0].msg).toMatchObject({ ok: true, result: 1, requestId: "r2" });
    });

    it("strips discriminator keys before dispatch and stamps outbound fields", async () => {
        const [serverPort, clientPort] = endpointPair();
        let receivedMsg = null;
        const hermes = new HermesHandler({
            op: (msg) => { receivedMsg = msg; return 1; },
        }, { logger: null });
        servePostMessage(hermes, serverPort, { inbound: { source: "app" }, outbound: { source: "server" } });

        clientPort.postMessage({ type: "op", requestId: "r1", source: "app" });
        await new Promise((r) => setTimeout(r, 10));

        expect(receivedMsg).toEqual({ type: "op", requestId: "r1" });
        expect(serverPort.posted[0].msg.source).toBe("server");
    });

    it("ignores response envelopes echoing on a shared channel", async () => {
        const [serverPort, clientPort] = endpointPair();
        const hermes = new HermesHandler({ op: () => 1 }, { logger: null });
        servePostMessage(hermes, serverPort);

        clientPort.postMessage({ ok: true, result: 9, type: "op", requestId: "r1" });
        await new Promise((r) => setTimeout(r, 10));

        expect(serverPort.posted).toEqual([]);
    });

    it("unsubscribes cleanly", async () => {
        const [serverPort, clientPort] = endpointPair();
        const hermes = new HermesHandler({ op: () => 1 }, { logger: null });
        const stop = servePostMessage(hermes, serverPort);
        stop();

        clientPort.postMessage({ type: "op", requestId: "r1" });
        await new Promise((r) => setTimeout(r, 10));

        expect(serverPort.posted).toEqual([]);
    });

    it("validates its arguments", () => {
        const [port] = endpointPair();
        expect(() => servePostMessage({}, port)).toThrow(TypeError);
        expect(() => servePostMessage(new HermesHandler({}, { logger: null }), {})).toThrow(TypeError);
    });
});

describe("end-to-end zero-copy intent", () => {
    it("client transfer out, ctx.transfer back — both directions captured", async () => {
        const [serverPort, clientPort] = endpointPair();
        const hermes = new HermesHandler({
            invert: (msg, ctx) => {
                const data = msg.payload.data; // ArrayBuffer arrived
                ctx.transfer(data);
                return { ok: true, result: { data } };
            },
        }, { logger: null });
        servePostMessage(hermes, serverPort);
        const dispatch = createHermesClient(postMessageTransport(clientPort));

        const buf = new ArrayBuffer(128);
        const res = await dispatch({ type: "invert", payload: { data: buf }, transfer: [buf] });

        expect(res.ok).toBe(true);
        expect(clientPort.posted[0].transfer).toEqual([buf]); // request moved out
        expect(serverPort.posted[0].transfer).toEqual([buf]); // response moved back
    });
});
