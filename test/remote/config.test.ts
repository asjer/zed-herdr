import { expect, test } from "bun:test";

import { parseRemoteConfig } from "../../src/remote/config.ts";

const environment = {
    ZED_HERDR_REMOTE_SOURCE: "/tmp/remote-source.js",
} as NodeJS.ProcessEnv;

test("remote config accepts SSH aliases and optional named sessions", () => {
    expect(parseRemoteConfig(["remote", "pi-remote.exe.xyz"], environment)).toMatchObject({
        sshTarget: "pi-remote.exe.xyz",
        session: undefined,
        sshBin: "ssh",
        scpBin: "scp",
    });
    expect(
        parseRemoteConfig(
            ["remote", "exedev@pi-remote.exe.xyz", "--session", "agents-1"],
            environment,
        ),
    ).toMatchObject({ sshTarget: "exedev@pi-remote.exe.xyz", session: "agents-1" });
});

test("remote config rejects option injection, whitespace, ports, and unsafe sessions", () => {
    for (const arguments_ of [
        ["remote", "-oProxyCommand=bad"],
        ["remote", "host name"],
        ["remote", "host:2222"],
        ["remote", "host", "--session", "../../bad"],
        ["remote", "host", "--other", "value"],
    ]) {
        expect(() => parseRemoteConfig(arguments_, environment)).toThrow();
    }
});

test("remote config requires an absolute source artifact override", () => {
    expect(() =>
        parseRemoteConfig(["remote", "host"], { ZED_HERDR_REMOTE_SOURCE: "relative.js" }),
    ).toThrow("absolute");
});
