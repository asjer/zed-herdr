import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

export const REMOTE_BRIDGE_PROTOCOL = 1 as const;
export const MAX_REMOTE_FRAME_BYTES = 64 * 1024;

const BridgeId = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(128));
const BridgePath = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const BridgeMessage = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));

export const RemoteHello = Schema.Struct({
    version: Schema.Literal(REMOTE_BRIDGE_PROTOCOL),
    type: Schema.Literal("hello"),
});
export type RemoteHello = Schema.Schema.Type<typeof RemoteHello>;

export const RemoteRequest = Schema.Struct({
    version: Schema.Literal(REMOTE_BRIDGE_PROTOCOL),
    type: Schema.Literal("request"),
    id: BridgeId,
    operation: Schema.Literal("ensure_project", "focus_project"),
    path: BridgePath,
});
export type RemoteRequest = Schema.Schema.Type<typeof RemoteRequest>;

export const RemoteResponse = Schema.Union(
    Schema.Struct({
        version: Schema.Literal(REMOTE_BRIDGE_PROTOCOL),
        type: Schema.Literal("response"),
        id: BridgeId,
        ok: Schema.Literal(true),
    }),
    Schema.Struct({
        version: Schema.Literal(REMOTE_BRIDGE_PROTOCOL),
        type: Schema.Literal("response"),
        id: BridgeId,
        ok: Schema.Literal(false),
        message: BridgeMessage,
    }),
);
export type RemoteResponse = Schema.Schema.Type<typeof RemoteResponse>;

export const RemoteSourceFrame = Schema.Union(RemoteHello, RemoteRequest);
export type RemoteSourceFrame = Schema.Schema.Type<typeof RemoteSourceFrame>;

export class RemoteProtocolError extends Error {
    readonly _tag = "RemoteProtocolError";

    constructor(message: string) {
        super(message.slice(0, 4_096));
        this.name = "RemoteProtocolError";
    }
}

const decodeJson = (frame: string): unknown => {
    try {
        return JSON.parse(frame);
    } catch {
        throw new RemoteProtocolError("Remote bridge sent invalid JSON");
    }
};

const decodeStrict = <A, I>(schema: Schema.Schema<A, I>, frame: string): A => {
    const decoded = Schema.decodeUnknownEither(schema)(decodeJson(frame), {
        onExcessProperty: "error",
    });
    if (Either.isLeft(decoded)) {
        throw new RemoteProtocolError(String(decoded.left));
    }
    return decoded.right;
};

export const decodeRemoteSourceFrame = (frame: string): RemoteSourceFrame =>
    decodeStrict(RemoteSourceFrame, frame);

export const decodeRemoteResponse = (frame: string): RemoteResponse =>
    decodeStrict(RemoteResponse, frame);

export const encodeRemoteFrame = (
    frame: RemoteSourceFrame | RemoteResponse,
): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`${JSON.stringify(frame)}\n`);

/** Fatal UTF-8, newline-delimited framing with a hard limit on every complete or partial frame. */
export class RemoteNdjsonDecoder {
    readonly #decoder = new TextDecoder("utf-8", { fatal: true });
    #chunks: Array<Uint8Array> = [];
    #bufferedBytes = 0;

    push(chunk: Uint8Array): ReadonlyArray<string> {
        const frames: Array<string> = [];
        let start = 0;

        for (;;) {
            const newline = chunk.indexOf(0x0a, start);
            if (newline < 0) {
                this.#append(chunk.subarray(start));
                return frames;
            }

            this.#append(chunk.subarray(start, newline));
            frames.push(this.#decodeFrame());
            start = newline + 1;
        }
    }

    end(): void {
        if (this.#bufferedBytes !== 0) {
            this.#reset();
            throw new RemoteProtocolError("Remote bridge ended with an unterminated frame");
        }
        try {
            this.#decoder.decode();
        } catch {
            throw new RemoteProtocolError("Remote bridge frame is not valid UTF-8");
        }
    }

    #append(chunk: Uint8Array): void {
        if (this.#bufferedBytes + chunk.byteLength > MAX_REMOTE_FRAME_BYTES) {
            throw new RemoteProtocolError("Remote bridge frame exceeds 64 KiB");
        }
        if (chunk.byteLength === 0) {
            return;
        }
        this.#chunks.push(chunk.slice());
        this.#bufferedBytes += chunk.byteLength;
    }

    #decodeFrame(): string {
        const bytes = new Uint8Array(this.#bufferedBytes);
        let offset = 0;
        for (const chunk of this.#chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this.#reset();

        const end = bytes.at(-1) === 0x0d ? bytes.byteLength - 1 : bytes.byteLength;
        try {
            return this.#decoder.decode(bytes.subarray(0, end));
        } catch {
            throw new RemoteProtocolError("Remote bridge frame is not valid UTF-8");
        }
    }

    #reset(): void {
        this.#chunks = [];
        this.#bufferedBytes = 0;
    }
}
