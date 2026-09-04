import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { makeRemoteBridgeEditorAdapter, RemoteSourceBridge } from "../../src/remote/source.ts";
import type { RemoteRequest } from "../../src/remote/protocol.ts";

class AsyncInput implements AsyncIterable<Uint8Array> {
    readonly #values: Array<Uint8Array | null> = [];
    readonly #waiters: Array<(value: Uint8Array | null) => void> = [];

    push(value: Uint8Array): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#values.push(value);
        } else {
            waiter(value);
        }
    }

    end(): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#values.push(null);
        } else {
            waiter(null);
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        for (;;) {
            const value =
                this.#values.length > 0
                    ? this.#values.shift()!
                    : await new Promise<Uint8Array | null>((resolve) =>
                          this.#waiters.push(resolve),
                      );
            if (value === null) {
                return;
            }
            yield value;
        }
    }
}

const response = (id: string, ok: boolean, message = "failed"): Uint8Array =>
    new TextEncoder().encode(
        `${JSON.stringify(
            ok
                ? { version: 1, type: "response", id, ok: true }
                : { version: 1, type: "response", id, ok: false, message },
        )}\n`,
    );

const requestFrom = (writes: ReadonlyArray<Uint8Array>): RemoteRequest =>
    JSON.parse(new TextDecoder().decode(writes[1])) as RemoteRequest;

test("remote source waits for the matching local Zed acknowledgement", async () => {
    const input = new AsyncInput();
    const writes: Array<Uint8Array> = [];
    const bridge = new RemoteSourceBridge({ input, write: (value) => writes.push(value) });
    bridge.start();
    const adapter = makeRemoteBridgeEditorAdapter(bridge);
    const pending = Effect.runPromise(adapter.focusProject("/remote/repo"));
    await Bun.sleep(0);

    expect(JSON.parse(new TextDecoder().decode(writes[0]))).toEqual({
        version: 1,
        type: "hello",
    });
    const request = requestFrom(writes);
    expect(request).toMatchObject({ operation: "focus_project", path: "/remote/repo" });
    input.push(response(request.id, true));
    await expect(pending).resolves.toBeUndefined();
    bridge.close();
    input.end();
});

test("remote source surfaces local failures and retries with a fresh request", async () => {
    const input = new AsyncInput();
    const writes: Array<Uint8Array> = [];
    const bridge = new RemoteSourceBridge({ input, write: (value) => writes.push(value) });
    bridge.start();
    const adapter = makeRemoteBridgeEditorAdapter(bridge);

    const failed = Effect.runPromise(adapter.ensureProject("/remote/repo"));
    await Bun.sleep(0);
    const first = requestFrom(writes);
    input.push(response(first.id, false, "zed unavailable"));
    await expect(failed).rejects.toThrow("zed unavailable");

    const retried = Effect.runPromise(adapter.ensureProject("/remote/repo"));
    await Bun.sleep(0);
    const second = JSON.parse(new TextDecoder().decode(writes[2])) as RemoteRequest;
    expect(second.id).not.toBe(first.id);
    input.push(response(second.id, true));
    await expect(retried).resolves.toBeUndefined();
    bridge.close();
    input.end();
});

test("a mismatched response id fails pending and future operations", async () => {
    const input = new AsyncInput();
    const writes: Array<Uint8Array> = [];
    const bridge = new RemoteSourceBridge({ input, write: (value) => writes.push(value) });
    bridge.start();
    const adapter = makeRemoteBridgeEditorAdapter(bridge);

    const pending = Effect.runPromise(adapter.focusProject("/remote/repo"));
    await Bun.sleep(0);
    input.push(response("wrong-id", true));
    await expect(pending).rejects.toThrow("does not match");
    await expect(Effect.runPromise(adapter.focusProject("/remote/repo"))).rejects.toThrow(
        "does not match",
    );
    input.end();
});

test("remote source bridge exposes input EOF so its process can terminate", async () => {
    const input = new AsyncInput();
    const bridge = new RemoteSourceBridge({ input, write: () => undefined });
    bridge.start();

    const closed = bridge.waitUntilClosed();
    input.end();

    await expect(closed).resolves.toBeUndefined();
    await expect(bridge.request("focus_project", "/remote/repo")).rejects.toThrow("input ended");
});
