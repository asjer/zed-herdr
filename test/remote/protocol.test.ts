import { expect, test } from "bun:test";

import {
    decodeRemoteResponse,
    decodeRemoteSourceFrame,
    encodeRemoteFrame,
    MAX_REMOTE_FRAME_BYTES,
    RemoteNdjsonDecoder,
    REMOTE_BRIDGE_PROTOCOL,
} from "../../src/remote/protocol.ts";

const encoder = new TextEncoder();

test("remote protocol round-trips bounded hello, request, and responses", () => {
    const request = {
        version: REMOTE_BRIDGE_PROTOCOL,
        type: "request",
        id: "request-1",
        operation: "focus_project",
        path: "/home/user/repo",
    } as const;
    const decoder = new RemoteNdjsonDecoder();
    const encoded = encodeRemoteFrame(request);
    const split = Math.floor(encoded.byteLength / 2);
    expect(decoder.push(encoded.subarray(0, split))).toEqual([]);
    const frames = decoder.push(encoded.subarray(split));
    expect(frames).toHaveLength(1);
    expect(decodeRemoteSourceFrame(frames[0]!)).toEqual(request);
    decoder.end();

    expect(
        decodeRemoteResponse(
            JSON.stringify({
                version: 1,
                type: "response",
                id: "request-1",
                ok: false,
                message: "zed failed",
            }),
        ),
    ).toEqual({
        version: 1,
        type: "response",
        id: "request-1",
        ok: false,
        message: "zed failed",
    });
});

test("remote protocol rejects excess keys, unknown versions, and unknown operations", () => {
    for (const value of [
        { version: 1, type: "hello", extra: true },
        { version: 2, type: "hello" },
        { version: 1, type: "request", id: "1", operation: "run", path: "/repo" },
    ]) {
        expect(() => decodeRemoteSourceFrame(JSON.stringify(value))).toThrow();
    }
});

test("remote framing rejects invalid UTF-8, oversized frames, and unterminated input", () => {
    expect(() => new RemoteNdjsonDecoder().push(new Uint8Array([0xc3, 0x28, 0x0a]))).toThrow(
        "valid UTF-8",
    );
    expect(() =>
        new RemoteNdjsonDecoder().push(new Uint8Array(MAX_REMOTE_FRAME_BYTES + 1).fill(65)),
    ).toThrow("exceeds 64 KiB");

    const unterminated = new RemoteNdjsonDecoder();
    unterminated.push(encoder.encode('{"version":1,"type":"hello"}'));
    expect(() => unterminated.end()).toThrow("unterminated frame");
});

test("remote framing yields multiple lines and accepts CRLF", () => {
    const decoder = new RemoteNdjsonDecoder();
    expect(decoder.push(encoder.encode("one\r\ntwo\n"))).toEqual(["one", "two"]);
    decoder.end();
});
