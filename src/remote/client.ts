import * as BunContext from "@effect/platform-bun/BunContext";
import * as Effect from "effect/Effect";

import { makeZedEditorAdapter } from "../editor/zed.ts";
import type { EditorAdapterService } from "../services/editor-adapter.ts";
import {
    decodeRemoteSourceFrame,
    encodeRemoteFrame,
    RemoteNdjsonDecoder,
    RemoteProtocolError,
    REMOTE_BRIDGE_PROTOCOL,
    type RemoteRequest,
} from "./protocol.ts";
import type { RemoteClientConfig } from "./config.ts";
import { makeOpenSshTransport, type RemoteChild, type RemoteTransport } from "./transport.ts";

const boundedMessage = (cause: unknown): string => {
    const rendered = cause instanceof Error ? cause.message : String(cause);
    const bounded = rendered.length <= 4_096 ? rendered : rendered.slice(rendered.length - 4_096);
    return bounded || "Zed operation failed";
};

export const sourceArtifactDigest = async (path: string): Promise<string> => {
    const bytes = await Bun.file(path).arrayBuffer();
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
};

const isAbsoluteRemotePath = (path: string): boolean =>
    path.startsWith("/") && !path.includes("\0");

const forwardStderr = async (child: RemoteChild): Promise<void> => {
    for await (const chunk of child.stderr) {
        const bounded =
            chunk.byteLength <= 4_096 ? chunk : chunk.subarray(chunk.byteLength - 4_096);
        process.stderr.write(bounded);
    }
};

export const runRemoteClient = async (
    config: RemoteClientConfig,
    transport: RemoteTransport = makeOpenSshTransport(),
): Promise<void> => {
    const digest = await sourceArtifactDigest(config.sourceArtifact);
    const remotePath = await transport.install(config, digest);
    const child = transport.connect(config, remotePath);
    const adapter = await Effect.runPromise(
        makeZedEditorAdapter(config.zedBin, process.platform, config.sshTarget).pipe(
            Effect.provide(BunContext.layer),
        ),
    );
    const decoder = new RemoteNdjsonDecoder();
    let receivedHello = false;
    let completed = false;
    const terminate = () => {
        if (!completed) {
            child.kill(15);
        }
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    const stderr = forwardStderr(child);

    try {
        for await (const chunk of child.stdout) {
            for (const frameText of decoder.push(chunk)) {
                if (frameText.length === 0) {
                    continue;
                }
                const frame = decodeRemoteSourceFrame(frameText);
                if (!receivedHello) {
                    if (frame.type !== "hello") {
                        throw new RemoteProtocolError("Remote source did not begin with hello");
                    }
                    receivedHello = true;
                    continue;
                }
                if (frame.type === "hello") {
                    throw new RemoteProtocolError("Remote source sent a duplicate hello");
                }
                if (!isAbsoluteRemotePath(frame.path)) {
                    throw new RemoteProtocolError("Remote source sent a non-absolute path");
                }
                await dispatchRequest(child, adapter, frame);
            }
        }
        decoder.end();
        const exitCode = await child.exited;
        completed = true;
        await stderr;
        if (!receivedHello) {
            throw new RemoteProtocolError("Remote source exited before hello");
        }
        if (exitCode !== 0) {
            throw new Error(`Remote source exited with code ${exitCode}`);
        }
    } finally {
        completed = true;
        process.off("SIGINT", terminate);
        process.off("SIGTERM", terminate);
        child.stdin.end();
        child.kill(15);
        await stderr.catch(() => undefined);
    }
};

const dispatchRequest = async (
    child: RemoteChild,
    adapter: EditorAdapterService,
    request: RemoteRequest,
): Promise<void> => {
    try {
        await Effect.runPromise(
            request.operation === "ensure_project"
                ? adapter.ensureProject(request.path)
                : adapter.focusProject(request.path),
        );
        child.stdin.write(
            encodeRemoteFrame({
                version: REMOTE_BRIDGE_PROTOCOL,
                type: "response",
                id: request.id,
                ok: true,
            }),
        );
    } catch (cause) {
        child.stdin.write(
            encodeRemoteFrame({
                version: REMOTE_BRIDGE_PROTOCOL,
                type: "response",
                id: request.id,
                ok: false,
                message: boundedMessage(cause),
            }),
        );
    }
};
