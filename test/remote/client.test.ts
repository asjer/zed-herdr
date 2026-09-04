import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runRemoteClient } from "../../src/remote/client.ts";
import type { RemoteClientConfig } from "../../src/remote/config.ts";
import type { RemoteChild, RemoteTransport } from "../../src/remote/transport.ts";

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
            if (value === null) return;
            yield value;
        }
    }
}

test("remote client dispatches a validated SSH project to local Zed and acknowledges it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-client-"));
    const sourceArtifact = join(directory, "remote-source.js");
    const zed = join(directory, "zed");
    const record = join(directory, "zed.json");
    const stdout = new AsyncInput();
    const stderr = new AsyncInput();
    const responses: Array<unknown> = [];
    let killed = false;
    const request = {
        version: 1,
        type: "request",
        id: "request-1",
        operation: "focus_project",
        path: "/home/exedev/work tree",
    } as const;

    try {
        await writeFile(sourceArtifact, "source bundle");
        await writeFile(
            zed,
            `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`,
        );
        await chmod(zed, 0o755);
        const exited = Promise.withResolvers<number>();
        const child: RemoteChild = {
            stdin: {
                write: (bytes) => {
                    responses.push(JSON.parse(new TextDecoder().decode(bytes)));
                    stdout.end();
                    exited.resolve(0);
                    return bytes.byteLength;
                },
                end: () => undefined,
            },
            stdout,
            stderr,
            exited: exited.promise,
            kill: () => {
                killed = true;
            },
        };
        const transport: RemoteTransport = {
            install: async (_config, digest) => {
                expect(digest).toMatch(/^[a-f0-9]{64}$/u);
                return `.cache/zed-herdr/${digest}.js`;
            },
            connect: () => child,
        };
        const config: RemoteClientConfig = {
            sshTarget: "pi-remote.exe.xyz",
            session: undefined,
            sourceArtifact,
            sshBin: "ssh",
            scpBin: "scp",
            zedBin: zed,
        };

        const running = runRemoteClient(config, transport);
        stderr.end();
        stdout.push(
            new TextEncoder().encode(
                `${JSON.stringify({ version: 1, type: "hello" })}\n${JSON.stringify(request)}\n`,
            ),
        );
        await running;

        expect(JSON.parse(await readFile(record, "utf8"))).toEqual([
            "-e",
            "ssh://pi-remote.exe.xyz/home/exedev/work%20tree",
        ]);
        expect(responses).toEqual([{ version: 1, type: "response", id: "request-1", ok: true }]);
        expect(killed).toBe(true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("remote client rejects requests before hello and never acknowledges them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-client-"));
    const sourceArtifact = join(directory, "remote-source.js");
    const stdout = new AsyncInput();
    const stderr = new AsyncInput();
    let killed = false;
    try {
        await writeFile(sourceArtifact, "source bundle");
        const child: RemoteChild = {
            stdin: { write: () => 0, end: () => undefined },
            stdout,
            stderr,
            exited: Promise.resolve(1),
            kill: () => {
                killed = true;
                stdout.end();
                stderr.end();
            },
        };
        const transport: RemoteTransport = {
            install: async () => `.cache/zed-herdr/${"a".repeat(64)}.js`,
            connect: () => child,
        };
        const running = runRemoteClient(
            {
                sshTarget: "host",
                session: undefined,
                sourceArtifact,
                sshBin: "ssh",
                scpBin: "scp",
                zedBin: "/missing/zed",
            },
            transport,
        );
        stdout.push(
            new TextEncoder().encode(
                `${JSON.stringify({
                    version: 1,
                    type: "request",
                    id: "1",
                    operation: "focus_project",
                    path: "/repo",
                })}\n`,
            ),
        );
        await expect(running).rejects.toThrow("begin with hello");
        expect(killed).toBe(true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
