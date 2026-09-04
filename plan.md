# Remote HerdR → local Zed support

## Goal

Add an opt-in remote bridge so local macOS Zed follows a workspace in an SSH-hosted HerdR session, without changing existing local plugin behavior or requiring HerdR core changes.

## Architecture

- Public command: `zed-herdr remote <ssh-target> [--session <name>]`.
- One long-lived SSH connection runs a remotely cached `remote-source` Bun bundle.
- The remote source connects to the remote HerdR socket, resolves and validates Git roots remotely, and sends only bounded typed project-operation frames.
- The local client invokes local Zed with a validated, encoded `ssh://authority/absolute/path` target and acknowledges success/failure.
- Existing `WorkspaceSource`, synchronization generation gates, debounce, and retry semantics remain authoritative.
- Remote paths remain protocol data; they never become shell text.

## Milestones

1. Add strict remote CLI/config decoding and safe SSH target/session validation.
2. Add a versioned, bounded, fatal-UTF-8 NDJSON bridge protocol.
3. Add SSH-mode Zed target construction while preserving local behavior.
4. Add a remote bridge-backed editor adapter and remote-source entrypoint.
5. Add a local coordinator and injected OpenSSH transport with exact argv, one long-lived connection, cleanup, and bounded reconnect behavior.
6. Package both entrypoints.
7. Cover protocol, transport, adapter, coordinator, remote source, and built-artifact E2E behavior.
8. Document installation, operation, security invariants, and first-release limits.
9. Run `bun run check`, then perform a real `pi-remote.exe.xyz` smoke test when the local/remote bundle is ready.

## First-release limits

- macOS local client; Linux/macOS SSH target.
- SSH aliases only; ports, jump hosts, keys, and other options come from `~/.ssh/config`.
- OpenSSH, Bun, Git, HerdR protocol 16+, and local Zed CLI are required.
- Worktree-backed workspaces are required for the initial end-to-end path unless remote cwd hints can be supported without weakening existing socket safety.
- Automatic coupling to the `herdr --remote` client lifecycle remains deferred until HerdR exposes a client-side integration seam.

## Status

Implemented and covered by the full local check. The real `pi-remote.exe.xyz` UI smoke test remains
for a Herdr-managed parent session because this worker is not attached to a HerdR pane.

## Validation

- Existing local daemon/plugin tests remain green.
- Exact argv assertions prove no shell construction.
- Remote protocol rejects oversized, malformed, unknown, and mismatched frames before Zed execution.
- A fake-SSH built-artifact E2E test proves authoritative snapshot → remote Git root → local Zed URI → acknowledgement.
- Real pilot: `pi-remote.exe.xyz`, with repeat focus and cleanup checked manually.
