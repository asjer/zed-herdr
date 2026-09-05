import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteClientConfig } from "./config.ts";

const REMOTE_CACHE_DIRECTORY = ".cache/zed-herdr";
const STDERR_LIMIT = 4_096;

export interface RemoteChild {
    readonly stdin: {
        readonly write: (bytes: Uint8Array) => number;
        readonly end: () => void;
    };
    readonly stdout: AsyncIterable<Uint8Array>;
    readonly stderr: AsyncIterable<Uint8Array>;
    readonly exited: Promise<number>;
    readonly kill: (signal?: number) => void;
}

export interface RemoteSourceArtifact {
    readonly bytes: Uint8Array;
    readonly digest: string;
}

export interface RemoteTransport {
    readonly install: (
        config: RemoteClientConfig,
        artifact: RemoteSourceArtifact,
    ) => Promise<string>;
    readonly connect: (config: RemoteClientConfig, remotePath: string) => RemoteChild;
}

const readStderrTail = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
    let tail = new Uint8Array(0);
    for await (const chunk of stream) {
        const retained = Math.min(tail.byteLength, Math.max(0, STDERR_LIMIT - chunk.byteLength));
        const nextLength = Math.min(STDERR_LIMIT, retained + chunk.byteLength);
        const next = new Uint8Array(nextLength);
        if (retained > 0) {
            next.set(tail.subarray(tail.byteLength - retained));
        }
        const source = chunk.subarray(Math.max(0, chunk.byteLength - (nextLength - retained)));
        next.set(source, retained);
        tail = next;
    }
    return new TextDecoder().decode(tail);
};

export const remoteCacheCommand = (config: RemoteClientConfig): ReadonlyArray<string> => [
    config.sshBin,
    "-T",
    config.sshTarget,
    "install",
    "-d",
    "-m",
    "700",
    REMOTE_CACHE_DIRECTORY,
];

export const remoteUploadCommand = (
    config: RemoteClientConfig,
    sourceArtifact: string,
    remotePath: string,
): ReadonlyArray<string> => [
    config.scpBin,
    "-q",
    sourceArtifact,
    `${config.sshTarget}:${remotePath}`,
];

export const remoteCommitCommand = (
    config: RemoteClientConfig,
    temporaryPath: string,
    remotePath: string,
): ReadonlyArray<string> => [
    config.sshBin,
    "-T",
    config.sshTarget,
    "mv",
    "-f",
    temporaryPath,
    remotePath,
];

export const remoteCleanupCommand = (
    config: RemoteClientConfig,
    temporaryPath: string,
): ReadonlyArray<string> => [config.sshBin, "-T", config.sshTarget, "rm", "-f", temporaryPath];

export const remoteConnectCommand = (
    config: RemoteClientConfig,
    remotePath: string,
): ReadonlyArray<string> => [
    config.sshBin,
    "-T",
    config.sshTarget,
    ...(config.session === undefined ? [] : ["env", `HERDR_SESSION=${config.session}`]),
    "bun",
    remotePath,
];

const runChecked = async (argv: ReadonlyArray<string>, operation: string): Promise<void> => {
    const child = Bun.spawn([...argv], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    const stderr = await readStderrTail(child.stderr);
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`${operation} failed with code ${exitCode}: ${stderr || "no stderr"}`);
    }
};

export const makeOpenSshTransport = (): RemoteTransport => ({
    install: async (config, artifact) => {
        const actualDigest = new Bun.CryptoHasher("sha256").update(artifact.bytes).digest("hex");
        if (!/^[a-f0-9]{64}$/u.test(artifact.digest) || actualDigest !== artifact.digest) {
            throw new Error("Remote source digest is invalid");
        }

        const remotePath = `${REMOTE_CACHE_DIRECTORY}/${artifact.digest}.js`;
        const temporaryPath = `${remotePath}.${crypto.randomUUID()}.tmp`;
        const stagingDirectory = await mkdtemp(join(tmpdir(), "zed-herdr-upload-"));
        const stagingPath = join(stagingDirectory, `${artifact.digest}.js`);

        try {
            await writeFile(stagingPath, artifact.bytes, { mode: 0o600 });
            await runChecked(remoteCacheCommand(config), "Remote cache setup");
            try {
                await runChecked(
                    remoteUploadCommand(config, stagingPath, temporaryPath),
                    "Remote source upload",
                );
                await runChecked(
                    remoteCommitCommand(config, temporaryPath, remotePath),
                    "Remote source install",
                );
            } catch (cause) {
                await runChecked(
                    remoteCleanupCommand(config, temporaryPath),
                    "Remote source cleanup",
                ).catch(() => undefined);
                throw cause;
            }
            return remotePath;
        } finally {
            await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
    },
    connect: (config, remotePath) => {
        if (!/^\.cache\/zed-herdr\/[a-f0-9]{64}\.js$/u.test(remotePath)) {
            throw new Error("Remote source path is invalid");
        }
        const child = Bun.spawn([...remoteConnectCommand(config, remotePath)], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        return child as unknown as RemoteChild;
    },
});
