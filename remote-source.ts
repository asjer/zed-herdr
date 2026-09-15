import * as BunRuntime from "@effect/platform-bun/BunRuntime";

import { runRemoteSource } from "./src/remote/source.ts";

// Effect's JSON logger writes through console.log; reserve stdout for bridge frames.
console.log = (...values: ReadonlyArray<unknown>) => console.error(...values);

BunRuntime.runMain(
    runRemoteSource({
        input: Bun.stdin.stream(),
        write: (bytes) => {
            process.stdout.write(bytes);
        },
    }),
    { disablePrettyLogger: true },
);
