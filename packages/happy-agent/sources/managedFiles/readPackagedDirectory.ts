import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ManagedFile } from "./syncManagedDirectory.js";

/**
 * Read every file a release ships in a directory, from the first candidate location that exists.
 *
 * Candidates list the packaged distribution location before the source-tree location.
 */
export async function readPackagedDirectory(
    candidates: readonly string[],
    label: string,
): Promise<readonly ManagedFile[]> {
    for (const candidate of candidates) {
        try {
            await access(candidate);
        } catch {
            continue;
        }
        return await readFiles(candidate, label);
    }
    throw new Error(`Happy Agent cannot find its packaged ${label}.`);
}

async function readFiles(sourceDirectory: string, label: string): Promise<readonly ManagedFile[]> {
    const files: ManagedFile[] = [];
    await visit(sourceDirectory);
    return files;

    async function visit(directory: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            } else if (entry.isFile()) {
                files.push({
                    contents: await readFile(path),
                    relativePath: relative(sourceDirectory, path),
                });
            } else {
                throw new Error(`Packaged Happy Agent ${label} contains an unsafe entry: ${path}`);
            }
        }
    }
}
