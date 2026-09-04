import { expect, test } from "bun:test";

import type { RemoteClientConfig } from "../../src/remote/config.ts";
import {
    remoteCacheCommand,
    remoteCommitCommand,
    remoteConnectCommand,
    remoteUploadCommand,
} from "../../src/remote/transport.ts";

const config = (session?: string): RemoteClientConfig => ({
    sshTarget: "pi-remote.exe.xyz",
    session,
    sourceArtifact: "/local/dist/remote-source.js",
    sshBin: "/tools/ssh",
    scpBin: "/tools/scp",
    zedBin: undefined,
});

const remotePath = `.cache/zed-herdr/${"a".repeat(64)}.js`;

test("OpenSSH transport builds exact argv without a shell or caller-provided options", () => {
    expect(remoteCacheCommand(config())).toEqual([
        "/tools/ssh",
        "-T",
        "pi-remote.exe.xyz",
        "install",
        "-d",
        "-m",
        "700",
        ".cache/zed-herdr",
    ]);
    expect(remoteUploadCommand(config(), remotePath)).toEqual([
        "/tools/scp",
        "-q",
        "/local/dist/remote-source.js",
        `pi-remote.exe.xyz:${remotePath}`,
    ]);
    const temporaryPath = `${remotePath}.00000000-0000-4000-8000-000000000000.tmp`;
    expect(remoteCommitCommand(config(), temporaryPath, remotePath)).toEqual([
        "/tools/ssh",
        "-T",
        "pi-remote.exe.xyz",
        "mv",
        "-f",
        temporaryPath,
        remotePath,
    ]);
    expect(remoteConnectCommand(config(), remotePath)).toEqual([
        "/tools/ssh",
        "-T",
        "pi-remote.exe.xyz",
        "bun",
        remotePath,
    ]);
});

test("named session reaches only the fixed env token in the long-lived command", () => {
    expect(remoteConnectCommand(config("agents-1"), remotePath)).toEqual([
        "/tools/ssh",
        "-T",
        "pi-remote.exe.xyz",
        "env",
        "HERDR_SESSION=agents-1",
        "bun",
        remotePath,
    ]);
});
