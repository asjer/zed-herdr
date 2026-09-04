import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface HerdRRequest {
    readonly id: string;
    readonly method: string;
}

interface Connection {
    buffer: string;
}

const indexArtifact = resolve(import.meta.dir, "../../dist/index.js");

class HerdRServer {
    readonly #listener: Bun.UnixSocketListener<Connection>;
    readonly #waiters = new Map<
        string,
        Array<(value: [HerdRRequest, Bun.Socket<Connection>]) => void>
    >();
    readonly #queued = new Map<string, Array<[HerdRRequest, Bun.Socket<Connection>]>>();

    constructor(path: string) {
        this.#listener = Bun.listen<Connection>({
            unix: path,
            socket: {
                open(socket) {
                    socket.data = { buffer: "" };
                },
                data: (socket, bytes) => {
                    socket.data.buffer += new TextDecoder().decode(bytes);
                    for (;;) {
                        const newline = socket.data.buffer.indexOf("\n");
                        if (newline < 0) return;
                        const text = socket.data.buffer.slice(0, newline);
                        socket.data.buffer = socket.data.buffer.slice(newline + 1);
                        if (!text) continue;
                        const request = JSON.parse(text) as HerdRRequest;
                        const waiter = this.#waiters.get(request.method)?.shift();
                        if (waiter !== undefined) waiter([request, socket]);
                        else {
                            const queued = this.#queued.get(request.method) ?? [];
                            queued.push([request, socket]);
                            this.#queued.set(request.method, queued);
                        }
                    }
                },
            },
        });
    }

    next(method: string): Promise<[HerdRRequest, Bun.Socket<Connection>]> {
        const queued = this.#queued.get(method)?.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((resolve) => {
            const waiters = this.#waiters.get(method) ?? [];
            waiters.push(resolve);
            this.#waiters.set(method, waiters);
        });
    }

    send(socket: Bun.Socket<Connection>, value: unknown): void {
        socket.write(`${JSON.stringify(value)}\n`);
    }

    close(): void {
        this.#listener.stop();
    }
}

const snapshot = (repo: string) => ({
    version: "0.8.0",
    protocol: 19,
    workspaces: [
        {
            workspace_id: "workspace-1",
            number: 1,
            label: "remote repo",
            focused: true,
            pane_count: 1,
            tab_count: 1,
            active_tab_id: "tab-1",
            agent_status: "idle",
            worktree: {
                repo_key: repo,
                repo_name: "repo",
                repo_root: repo,
                checkout_path: repo,
                is_linked_worktree: true,
            },
        },
    ],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    focused_workspace_id: "workspace-1",
    focused_tab_id: "tab-1",
    focused_pane_id: null,
});

const waitForLines = async (path: string, count: number): Promise<ReadonlyArray<string>> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const text = await readFile(path, "utf8").catch(() => "");
        const lines = text.trim().length === 0 ? [] : text.trim().split("\n");
        if (lines.length >= count) return lines;
        await Bun.sleep(25);
    }
    throw new Error(`Timed out waiting for ${count} Zed records`);
};

test("built remote bridge carries authoritative remote Git roots to local Zed over one SSH process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-remote-e2e-"));
    const remoteHome = join(directory, "remote-home");
    const socketPath = join(directory, "herdr.sock");
    const zedRecords = join(directory, "zed-records.ndjson");
    const fakeSsh = join(directory, "ssh");
    const fakeScp = join(directory, "scp");
    const fakeZed = join(directory, "zed");
    const repoPath = join(directory, "repo with space");
    let client: Bun.Subprocess | undefined;
    const herdr = new HerdRServer(socketPath);

    try {
        await Bun.$`mkdir -p ${remoteHome}`.quiet();
        expect((await Bun.$`git init --quiet ${repoPath}`.quiet()).exitCode).toBe(0);
        const repo = await realpath(repoPath);
        await writeFile(
            fakeSsh,
            `#!/usr/bin/env bun
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const home = process.env.FAKE_REMOTE_HOME;
if (!home) process.exit(90);
const remote = args.slice(2);
if (remote[0] === "install" && remote[1] === "-d") {
  await mkdir(join(home, remote[4]), { recursive: true });
  process.exit(0);
}
if (remote[0] === "mv" && remote[1] === "-f") {
  await rename(join(home, remote[2]), join(home, remote[3]));
  process.exit(0);
}
let command = remote;
if (command[0] === "env") {
  const [key, value] = command[1].split("=", 2);
  process.env[key] = value;
  command = command.slice(2);
}
if (command[0] !== "bun") process.exit(91);
const child = Bun.spawn([process.execPath, join(home, command[1])], {
  env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit"
});
process.exit(await child.exited);
`,
        );
        await writeFile(
            fakeScp,
            `#!/usr/bin/env bun
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const source = args[1];
const destination = args[2];
const relative = destination.slice(destination.indexOf(":") + 1);
await copyFile(source, join(process.env.FAKE_REMOTE_HOME, relative));
`,
        );
        await writeFile(
            fakeZed,
            `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
await appendFile(process.env.ZED_RECORDS, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
        );
        await Promise.all([fakeSsh, fakeScp, fakeZed].map((path) => chmod(path, 0o755)));

        client = Bun.spawn([process.execPath, indexArtifact, "remote", "pi-remote.exe.xyz"], {
            env: {
                ...process.env,
                FAKE_REMOTE_HOME: remoteHome,
                HERDR_SOCKET_PATH: socketPath,
                ZED_BIN: fakeZed,
                ZED_RECORDS: zedRecords,
                ZED_HERDR_SSH_BIN: fakeSsh,
                ZED_HERDR_SCP_BIN: fakeScp,
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });

        const [initial, initialSocket] = await herdr.next("session.snapshot");
        herdr.send(initialSocket, {
            id: initial.id,
            result: { type: "session_snapshot", snapshot: snapshot(repo) },
        });
        const [subscription, subscriptionSocket] = await herdr.next("events.subscribe");
        herdr.send(subscriptionSocket, {
            id: subscription.id,
            result: { type: "subscription_started" },
        });
        const [authoritative, authoritativeSocket] = await herdr.next("session.snapshot");
        herdr.send(authoritativeSocket, {
            id: authoritative.id,
            result: { type: "session_snapshot", snapshot: snapshot(repo) },
        });

        const lines = await waitForLines(zedRecords, 2);
        expect(lines.map((line) => JSON.parse(line))).toEqual([
            ["-e", `ssh://pi-remote.exe.xyz${repo.replaceAll(" ", "%20")}`],
            ["-e", `ssh://pi-remote.exe.xyz${repo.replaceAll(" ", "%20")}`],
        ]);
    } finally {
        client?.kill(15);
        if (client !== undefined) await client.exited;
        herdr.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 15_000);
