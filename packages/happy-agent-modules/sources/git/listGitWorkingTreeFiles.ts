import { Type, type Static } from "@sinclair/typebox";

import { runScanGit, type ScanGitRunner } from "./runScanGit.js";

const WORKING_TREE_FILE_LIMIT = 20_000;

export const gitWorkingTreeFilesSchema = Type.Object(
    {
        paths: Type.Array(Type.String()),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type GitWorkingTreeFiles = Static<typeof gitWorkingTreeFilesSchema>;

/**
 * `match` narrows the listing to paths holding its letters in order, whatever their case and
 * wherever they fall, as a typed file search does; whitespace in it is ignored. It lets a search
 * reach files a whole listing would leave past its cap.
 */
export async function listGitWorkingTreeFiles(options: {
    match?: string;
    path: string;
    runGit?: ScanGitRunner;
    signal?: AbortSignal;
}): Promise<GitWorkingTreeFiles> {
    const pathspec = options.match === undefined ? [] : ["--", subsequencePathspec(options.match)];
    const run = async (args: readonly string[]) =>
        await (options.runGit ?? runScanGit)({
            args: ["ls-files", "-z", ...args, ...pathspec],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    let result;
    let deleted;
    try {
        // The index still holds a tracked file removed from disk; the working tree does not.
        [result, deleted] = await Promise.all([
            run(["--cached", "--others", "--exclude-standard"]),
            run(["--deleted"]),
        ]);
    } catch (error) {
        if (isMissingRepository(error)) return { paths: [], truncated: false };
        throw error;
    }
    const removed = new Set(entries(deleted));
    const paths = [...new Set(entries(result))]
        .filter((path) => !removed.has(path))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return {
        paths: paths.slice(0, WORKING_TREE_FILE_LIMIT),
        truncated: result.truncated || paths.length > WORKING_TREE_FILE_LIMIT,
    };
}

/** A case-insensitive pathspec matching every path that holds `match`'s letters in order. */
function subsequencePathspec(match: string): string {
    const letters = [...match.replaceAll(/\s+/gu, "")].map((letter) =>
        "*?[]\\".includes(letter) ? `\\${letter}` : letter,
    );
    return `:(icase)*${letters.map((letter) => `${letter}*`).join("")}`;
}

/** The complete NUL-separated paths of one listing, without a cut-off last one. */
function entries(result: { readonly stdout: string; readonly truncated: boolean }): string[] {
    const stdout = result.truncated
        ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
        : result.stdout;
    return stdout.split("\0").filter(Boolean);
}

function isMissingRepository(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const message = error instanceof Error ? error.message : "";
    return `${message}\n${stderr}`.includes("not a git repository (or any");
}
