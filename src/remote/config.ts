import { isAbsolute, join } from "node:path";

export interface RemoteClientConfig {
    readonly sshTarget: string;
    readonly session: string | undefined;
    readonly sourceArtifact: string;
    readonly sshBin: string;
    readonly scpBin: string;
    readonly zedBin: string | undefined;
}

const SSH_TARGET =
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const isValidSshTarget = (value: string): boolean =>
    value.length <= 255 && SSH_TARGET.test(value);

export const isValidSession = (value: string): boolean => SESSION.test(value);

const executable = (environment: NodeJS.ProcessEnv, key: string, fallback: string): string => {
    const value = environment[key]?.trim();
    if (environment[key] !== undefined && !value) {
        throw new Error(`${key} must be non-empty`);
    }
    return value ?? fallback;
};

export const parseRemoteConfig = (
    arguments_: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv = process.env,
    artifactDirectory: string = import.meta.dir,
): RemoteClientConfig => {
    if (
        arguments_.length !== 2 &&
        !(arguments_.length === 4 && arguments_[2] === "--session" && arguments_[3] !== undefined)
    ) {
        throw new Error("Usage: zed-herdr remote <ssh-target> [--session <name>]");
    }

    const sshTarget = arguments_[1] ?? "";
    if (!isValidSshTarget(sshTarget)) {
        throw new Error(
            "SSH target must be a host or [user@]host alias without whitespace or options",
        );
    }

    const session = arguments_.length === 4 ? arguments_[3] : undefined;
    if (session !== undefined && !isValidSession(session)) {
        throw new Error("HerdR session name contains unsupported characters");
    }

    const configuredArtifact = environment.ZED_HERDR_REMOTE_SOURCE?.trim();
    if (environment.ZED_HERDR_REMOTE_SOURCE !== undefined && !configuredArtifact) {
        throw new Error("ZED_HERDR_REMOTE_SOURCE must be non-empty");
    }
    const sourceArtifact = configuredArtifact ?? join(artifactDirectory, "remote-source.js");
    if (!isAbsolute(sourceArtifact)) {
        throw new Error("Remote source artifact path must be absolute");
    }

    const zedBin = environment.ZED_BIN?.trim();
    if (environment.ZED_BIN !== undefined && !zedBin) {
        throw new Error("ZED_BIN must be non-empty");
    }

    return {
        sshTarget,
        session,
        sourceArtifact,
        sshBin: executable(environment, "ZED_HERDR_SSH_BIN", "ssh"),
        scpBin: executable(environment, "ZED_HERDR_SCP_BIN", "scp"),
        zedBin,
    };
};
