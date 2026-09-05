# Zed editor adapter

[Documentation index](README.md)

## Purpose

The Zed adapter implements `EditorAdapter` through Zed's supported, state-preserving public CLI
boundary. It does not inspect Zed storage, replace windows, automate UI, or invoke a shell.

## Responsibilities

[`makeZedEditorAdapter`](../src/editor/zed.ts) builds the service;
[`makeZedEditorAdapterLayer`](../src/editor/zed.ts) supplies it as an Effect layer. The adapter:

- rejects a project path unless it is absolute;
- uses the configured executable directly, or asks the command executor to resolve `"zed"` from
  `PATH`;
- only when no executable was configured and the platform is macOS, retries a primary
  executable-not-found start failure with `/Applications/Zed.app/Contents/MacOS/cli`;
- invokes exact shell-free argv `[executable, "-e", projectTarget]`.

Local adapters use the absolute Git root as `projectTarget`. A remote adapter is constructed with
one validated SSH authority and converts each absolute POSIX Git root into
`ssh://authority/percent-encoded-path`. Path separators remain separators; spaces, `%`, `#`, and
Unicode path segments are encoded. The authority and path are still one data argument and never
become executable or shell syntax.

The macOS fallback is not used for nonzero exits, timeouts, process errors, other start failures, or
an explicitly configured executable.

## Contracts and state

A single-permit semaphore serializes every ensure and focus operation. An adapter-lifetime
`ensuredRoots` set records only roots whose `ensureProject` command completed successfully.
Repeated ensures of a recorded root skip the process call.

`focusProject` is unconditional: every call reaches Zed even if the same root was focused
previously. The [synchronization daemon](synchronization.md) owns separate generation-local
deduplication before it calls the adapter.

## Flow

1. Validate the absolute local path, or the fixed SSH authority plus absolute POSIX remote path.
2. Construct the local path or encoded SSH project target.
3. Select the configured executable or `"zed"`.
4. Start `Command.make(executable, "-e", projectTarget)` without a shell.
5. Drain stdout and stderr concurrently while waiting for process exit.
6. Retain only the final 4,096 bytes of stderr.
7. Return success for exit code `0`; otherwise return `EditorAdapterError`.

`ensureProject` inserts the root into its cache after step 6 succeeds. `focusProject` records no
adapter state.

## Failure boundaries

The process has a five-second timeout. On timeout the adapter sends `SIGKILL`, joins both output
drainers, and returns an error with the captured stderr tail. Start failures, stdout/stderr or
exit-code process failures, nonzero exits, and timeouts become `EditorAdapterError` with operation
`"ensure_project"` or `"focus_project"`, the path, bounded stderr/message, and an exit code when a
nonzero process exit supplied one.

Failures never enter the successful-root cache. The semaphore remains scoped around the operation,
so concurrent calls cannot interleave Zed processes or cache decisions.

## Implementation and tests

- [`src/editor/zed.ts`](../src/editor/zed.ts)
- [`src/services/editor-adapter.ts`](../src/services/editor-adapter.ts)
- [`test/editor/zed.test.ts`](../test/editor/zed.test.ts)
- [`test/e2e/daemon.test.ts`](../test/e2e/daemon.test.ts)
- [`test/e2e/remote.test.ts`](../test/e2e/remote.test.ts)

## Related

- [Runtime composition](runtime.md)
- [Service ports](services.md)
- [Synchronization core](synchronization.md)
