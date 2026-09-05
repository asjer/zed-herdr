import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteClientConfig } from "../../src/remote/config.ts";
import {
    makeOpenSshTransport,
    remoteCacheCommand,
    remoteCleanupCommand,
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
    expect(remoteUploadCommand(config(), "/staged/remote-source.js", remotePath)).toEqual([
        "/tools/scp",
        "-q",
        "/staged/remote-source.js",
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
    expect(remoteCleanupCommand(config(), temporaryPath)).toEqual([
        "/tools/ssh",
        "-T",
        "pi-remote.exe.xyz",
        "rm",
        "-f",
        temporaryPath,
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

test("install failures preserve the original error and clean remote temporary files when possible", async () => {
    const bytes = new TextEncoder().encode("immutable remote source");
    const artifact = {
        bytes,
        digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };

    for (const failure of ["upload", "commit", "cleanup"] as const) {
        const directory = await mkdtemp(join(tmpdir(), `zed-herdr-${failure}-`));
        const remoteHome = join(directory, "remote");
        const ssh = join(directory, "ssh");
        const scp = join(directory, "scp");
        await mkdir(remoteHome);

        try {
            await writeFile(
                ssh,
                `#!/usr/bin/env bun
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
const remote = process.argv.slice(4);
const home = ${JSON.stringify(remoteHome)};
if (remote[0] === "install") {
  await mkdir(join(home, remote[4]), { recursive: true });
  process.exit(0);
}
if (remote[0] === "rm") {
  if (${JSON.stringify(failure)} === "cleanup") {
    console.error("cleanup failure");
    process.exit(9);
  }
  await rm(join(home, remote[2]), { force: true });
  process.exit(0);
}
if (remote[0] === "mv") {
  if (${JSON.stringify(failure)} === "commit") {
    console.error("commit failure");
    process.exit(8);
  }
  await rename(join(home, remote[2]), join(home, remote[3]));
  process.exit(0);
}
process.exit(90);
`,
            );
            await writeFile(
                scp,
                `#!/usr/bin/env bun
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const source = args[1];
const relative = args[2].slice(args[2].indexOf(":") + 1);
const destination = join(${JSON.stringify(remoteHome)}, relative);
await mkdir(dirname(destination), { recursive: true });
if (${JSON.stringify(failure)} !== "commit") {
  await writeFile(destination, "partial");
  console.error("upload failure");
  process.exit(7);
}
await copyFile(source, destination);
`,
            );
            await Promise.all([ssh, scp].map((path) => chmod(path, 0o755)));

            const installing = makeOpenSshTransport().install(
                { ...config(), sshBin: ssh, scpBin: scp },
                artifact,
            );
            await expect(installing).rejects.toThrow(
                failure === "commit"
                    ? "Remote source install failed with code 8"
                    : "Remote source upload failed with code 7",
            );
            const remoteFiles = await readdir(join(remoteHome, ".cache/zed-herdr"));
            expect(remoteFiles).toHaveLength(failure === "cleanup" ? 1 : 0);
            if (failure === "cleanup") {
                expect(remoteFiles[0]).toEndWith(".tmp");
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
});
