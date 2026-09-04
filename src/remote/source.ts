import * as BunContext from "@effect/platform-bun/BunContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";

import { EditorAdapterError } from "../domain/errors.ts";
import { HerdRClientLive } from "../herdr/client.ts";
import { HerdRWorkspaceSourceLive } from "../herdr/workspace-source.ts";
import { EditorAdapter } from "../services/editor-adapter.ts";
import type { EditorAdapterService } from "../services/editor-adapter.ts";
import { WorkspaceHintSource } from "../services/workspace-hint-source.ts";
import { makeSyncDaemon } from "../sync/daemon.ts";
import {
    decodeRemoteResponse,
    encodeRemoteFrame,
    RemoteNdjsonDecoder,
    RemoteProtocolError,
    REMOTE_BRIDGE_PROTOCOL,
    type RemoteRequest,
} from "./protocol.ts";

export interface RemoteBridgeIo {
    readonly input: AsyncIterable<Uint8Array>;
    readonly write: (bytes: Uint8Array) => void;
}

type Pending = {
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
};

export class RemoteSourceBridge {
    readonly #io: RemoteBridgeIo;
    readonly #pending = new Map<string, Pending>();
    #failure: Error | null = null;
    #reader: Promise<void> | null = null;

    constructor(io: RemoteBridgeIo) {
        this.#io = io;
    }

    start(): void {
        if (this.#reader !== null) {
            return;
        }
        this.#io.write(encodeRemoteFrame({ version: REMOTE_BRIDGE_PROTOCOL, type: "hello" }));
        this.#reader = this.#read();
    }

    close(): void {
        this.#failAll(new RemoteProtocolError("Remote bridge closed"));
    }

    request(operation: RemoteRequest["operation"], path: string): Promise<void> {
        if (this.#reader === null) {
            return Promise.reject(new RemoteProtocolError("Remote bridge was not started"));
        }
        if (this.#failure !== null) {
            return Promise.reject(this.#failure);
        }
        const id = crypto.randomUUID();
        const result = Promise.withResolvers<void>();
        const timer = setTimeout(() => {
            this.#pending.delete(id);
            result.reject(new RemoteProtocolError("Remote Zed acknowledgement timed out"));
        }, 7_000);
        this.#pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
        this.#io.write(
            encodeRemoteFrame({
                version: REMOTE_BRIDGE_PROTOCOL,
                type: "request",
                id,
                operation,
                path,
            }),
        );
        return result.promise;
    }

    async #read(): Promise<void> {
        const decoder = new RemoteNdjsonDecoder();
        try {
            for await (const chunk of this.#io.input) {
                for (const frame of decoder.push(chunk)) {
                    if (frame.length === 0) {
                        continue;
                    }
                    const response = decodeRemoteResponse(frame);
                    const pending = this.#pending.get(response.id);
                    if (pending === undefined) {
                        throw new RemoteProtocolError(
                            "Remote response id does not match a request",
                        );
                    }
                    clearTimeout(pending.timer);
                    this.#pending.delete(response.id);
                    if (response.ok) {
                        pending.resolve();
                    } else {
                        pending.reject(new RemoteProtocolError(response.message));
                    }
                }
            }
            decoder.end();
            throw new RemoteProtocolError("Remote bridge input ended");
        } catch (cause) {
            this.#failAll(
                cause instanceof Error
                    ? cause
                    : new RemoteProtocolError("Remote bridge input failed"),
            );
        }
    }

    #failAll(cause: Error): void {
        if (this.#failure === null) {
            this.#failure = cause;
        }
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this.#failure);
        }
        this.#pending.clear();
    }
}

const adapterFailure = (
    operation: RemoteRequest["operation"],
    path: string,
    cause: unknown,
): EditorAdapterError => {
    const rendered = cause instanceof Error ? cause.message : String(cause);
    return new EditorAdapterError({
        operation,
        path: path || ".",
        exitCode: null,
        stderr: "",
        message: rendered.slice(-4_096) || "Remote editor bridge failed",
    });
};

export const makeRemoteBridgeEditorAdapter = (
    bridge: RemoteSourceBridge,
): EditorAdapterService => ({
    ensureProject: (path) =>
        Effect.tryPromise({
            try: () => bridge.request("ensure_project", path),
            catch: (cause) => adapterFailure("ensure_project", path, cause),
        }),
    focusProject: (path) =>
        Effect.tryPromise({
            try: () => bridge.request("focus_project", path),
            catch: (cause) => adapterFailure("focus_project", path, cause),
        }),
});

const JsonLoggerLive = Logger.json;
const HerdRClientLiveWithLogger = HerdRClientLive.pipe(Layer.provide(JsonLoggerLive));
const HerdRSourceLive = HerdRWorkspaceSourceLive.pipe(
    Layer.provideMerge(HerdRClientLiveWithLogger),
);

export const runRemoteSource = (io: RemoteBridgeIo) =>
    Effect.scoped(
        Effect.gen(function* () {
            const bridge = new RemoteSourceBridge(io);
            yield* Effect.acquireRelease(
                Effect.sync(() => bridge.start()),
                () => Effect.sync(() => bridge.close()),
            );
            const layer = Layer.mergeAll(
                BunContext.layer,
                HerdRSourceLive,
                Layer.succeed(EditorAdapter, makeRemoteBridgeEditorAdapter(bridge)),
                Layer.succeed(WorkspaceHintSource, { hints: Stream.empty }),
            ).pipe(Layer.provideMerge(JsonLoggerLive));
            return yield* Effect.gen(function* () {
                const daemon = yield* makeSyncDaemon;
                return yield* daemon.run;
            }).pipe(Effect.provide(layer));
        }),
    ).pipe(Effect.provide(JsonLoggerLive));
