# Zed Workspace Sync

[![Plugin Demo](https://img.youtube.com/vi/Q_i-IKda7hE/maxresdefault.jpg)](https://youtu.be/Q_i-IKda7hE)

HerdR plugin `artisann.zed-herdr` keeps the active HerdR workspace available in Zed without taking ownership of either application. It supports macOS and Linux, HerdR **0.7.3+** reporting protocol **16 or newer** (tested through protocol **19**), Bun, Git, and Zed with its `zed` CLI available.

For contributor architecture and subsystem internals, see [the documentation index](docs/README.md).

## Build and install

Run plugin commands from a HerdR environment (`HERDR_ENV=1`), then build and link this checkout:

```bash
cd zed-herdr
bun install --frozen-lockfile
bun run build
herdr plugin link ImArtisann/zed-herdr
herdr plugin enable artisann.zed-herdr
```

Linking makes the local checkout available to HerdR; enabling activates its declared hooks. The plugin starts automatically for `workspace.created` and `workspace.focused` events. Its hook opens its own **unfocused** `Zed Workspace Sync` tab only when no live plugin daemon is available.

For direct development, run the same daemon without the plugin host:

```bash
bun run dev
# or, without watch mode:
bun run start
```

Both commands require access to the current HerdR session socket. The built artifact can also be started directly with `bun ./dist/index.js daemon`.

## Remote HerdR with local Zed

Remote mode is an explicit foreground companion for `herdr --remote`. Build locally, then start one
companion for each remote target and optional named session:

```bash
bun run build
bun ./dist/index.js remote pi-remote.exe.xyz
# named remote session:
bun ./dist/index.js remote pi-remote.exe.xyz --session agents
```

Keep that command running while attaching in another terminal:

```bash
herdr --remote pi-remote.exe.xyz
# or: herdr --remote pi-remote.exe.xyz --session agents
```

The SSH target must be the same SSH-config alias Zed can use. Put ports, jump hosts, identity files,
and other SSH options in `~/.ssh/config`; remote mode deliberately accepts no caller-provided SSH
flags. The local machine needs OpenSSH and Zed. The remote host needs Bun, Git, HerdR 0.7.3+, and a
running HerdR session. Bun must be available to a noninteractive SSH command. The plugin does not
need to be installed remotely. If it was previously enabled there, disable it so its normal hook
does not open a second daemon that tries to control a remote desktop:

```bash
herdr plugin disable artisann.zed-herdr
```

At startup the companion hashes `dist/remote-source.js`, uploads it under the remote user's
`.cache/zed-herdr/`, and starts it over one long-lived SSH connection. The source reads only the
remote HerdR socket, validates worktree Git roots on the remote host, and sends bounded typed
ensure/focus requests. The local process invokes only
`zed -e ssh://<ssh-target>/<encoded-absolute-path>` and acknowledges the result before the remote
synchronizer records success.

Remote mode currently supports **worktree-backed workspaces only**. Non-worktree workspaces require
the plugin's remote cwd hint, which is not forwarded by HerdR's thin client. Automatic start/stop
with `herdr --remote`, arbitrary SSH command-line options, and remote hosts without Bun are also out
of scope for this first release. Stop the companion with `Ctrl+C`; an SSH disconnect ends it, so
restart the command after reconnecting.

## Health and inspection

Ask the daemon on the current session's control socket for its health:

```bash
bun dist/index.js health
```

A successful response is JSON shaped like:

```json
{
    "ok": true,
    "daemon": {
        "identity": "artisann.zed-herdr:daemon",
        "paneId": "<pane-id>",
        "pid": 1234,
        "startedAt": "2026-01-01T00:00:00.000Z",
        "protocol": 19,
        "beyondTested": false
    }
}
```

`identity` identifies this plugin's owner-validated local daemon, `paneId` is the plugin pane that hosts it (or `null` when not injected by HerdR), and `pid`/`startedAt` identify that daemon instance. `protocol` is the last protocol accepted from HerdR, or `null` before negotiation; `beyondTested` is true when it is newer than protocol 19. Exit status `1` means no valid matching daemon answered; it does not start one.

Use the plugin registry and plugin log to inspect the installation:

```bash
herdr plugin list --plugin artisann.zed-herdr --json
herdr plugin log list --plugin artisann.zed-herdr --limit 100
```

Use the `paneId` from `health` (or the response from a manual plugin-pane open) to inspect the daemon terminal:

```bash
herdr pane read <pane-id> --source recent-unwrapped --lines 100 --format text
```

HerdR 0.7.3 exposes plugin-pane `open`, `focus`, and `close` operations; use the health response rather than relying on a plugin-pane listing command.

## Configuration and behavior

Set `ZED_BIN` to a non-empty executable path to select a Zed CLI explicitly:

```bash
export ZED_BIN=/absolute/path/to/zed
```

Without `ZED_BIN`, the daemon resolves `zed` from `PATH`; on macOS an executable-not-found result also tries Zed's standard application CLI path. Local mode invokes only `zed -e <absolute-git-root>`; remote mode invokes the same exact argv with a percent-encoded `ssh://` project target.

For HerdR transport, `HERDR_SOCKET_PATH` takes precedence. Otherwise the socket is resolved as:

1. `$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION/herdr.sock` for a named session, or `~/.config/herdr/sessions/$HERDR_SESSION/herdr.sock` when `XDG_CONFIG_HOME` is unset.
2. `$XDG_CONFIG_HOME/herdr/herdr.sock`, or `~/.config/herdr/herdr.sock`, when there is no named session.

The daemon reads HerdR snapshots and lifecycle events, then asks Zed to add/focus a validated Git root. It never sends a mutating HerdR request, kills a process, reuses an existing pane, replaces Zed window/project state, accesses Zed's private storage, or uses Zed's state-replacing CLI options. Non-worktree workspaces wait for the plugin hook's workspace cwd hint; ambiguous, inaccessible, or non-Git paths are skipped.

## Pause and resume Zed control

HerdR plugin manifests declare actions but do not install user keybindings. Add this command binding
to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+z"
type = "plugin_action"
command = "artisann.zed-herdr.toggle"
description = "Toggle Zed workspace sync"
```

Apply it to the running HerdR server:

```bash
herdr server reload-config
```

Then press the HerdR prefix followed by `Shift+Z`. Disabling interrupts in-flight synchronization
and suppresses new Zed calls while HerdR remains authoritative. Re-enabling requests a fresh
snapshot for the current generation.

The same action is available from the built CLI:

```bash
bun dist/index.js toggle
```

It prints `{"ok":true,"enabled":false}` or `{"ok":true,"enabled":true}`. A newly started daemon
begins enabled. This runtime pause is separate from `herdr plugin disable`, which disables the
action target but leaves the user-configured keybinding in place.

## Troubleshooting

- **Protocol mismatch:** HerdR must report protocol 16 or newer. A value below 16 is logged as `herdr_protocol_unsupported` and stops reconnecting rather than guessing or downgrading. Newer values are accepted; values above the highest tested protocol are reported by `health` with `beyondTested: true` and log `herdr_protocol_beyond_tested` once.
- **Socket or health failure:** confirm `HERDR_SOCKET_PATH`, `HERDR_SESSION`, and `XDG_CONFIG_HOME` describe the intended session, then inspect the plugin log and daemon pane output above. Focusing or creating a workspace will run the activation hook again.
- **Zed errors:** ensure `ZED_BIN` points to an executable, or that `zed` is on `PATH`; inspect the daemon or remote-companion output for the failed `zed -e` command. The daemon leaves HerdR and existing Zed state unchanged when Zed rejects or times out.
- **Remote source exits before hello:** verify normal `ssh <target>`, then verify `ssh <target> bun --version`; remote mode does not guess an interactive-shell Bun path.
- **Remote workspace is skipped:** remote mode intentionally has no cwd-hint bridge. Use a HerdR worktree-backed workspace and inspect the remote companion's `workspace_sync_skipped` log.

## Disable or remove

For a linked checkout, stop future hook activation and remove the link:

```bash
herdr plugin disable artisann.zed-herdr
herdr plugin unlink artisann.zed-herdr
```

For a plugin installed from a remote source instead of linked from this checkout, use:

```bash
herdr plugin uninstall artisann.zed-herdr
```
