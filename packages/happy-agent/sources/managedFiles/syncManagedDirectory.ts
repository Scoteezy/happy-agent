import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface ManagedFile {
    readonly contents: string | Uint8Array;
    readonly relativePath: string;
}

export interface ManagedDirectoryOptions {
    /** What the files are, as error messages name them, such as "documentation". */
    readonly label: string;
    /** Remove every file and folder in the directory that this release does not ship. */
    readonly prune?: boolean;
}

/**
 * Atomically synchronize the files one release ships into a managed, read-only directory.
 *
 * Every shipped file is replaced atomically. With `prune`, whatever the release no longer ships is
 * removed afterwards, so a start that fails part-way leaves the previous files rather than none.
 */
export async function syncManagedDirectory(
    directory: string,
    files: readonly ManagedFile[],
    options: ManagedDirectoryOptions,
): Promise<void> {
    const { label } = options;
    if (files.length === 0) throw new Error(`Happy Agent ships no ${label}.`);
    await mkdir(dirname(directory), { recursive: true });
    await ensureSafeDirectory(directory, label);

    const shipped = new Set<string>();
    for (const file of files) {
        const relativePath = validateRelativePath(file.relativePath, label);
        const target = join(directory, relativePath);
        if (escapes(directory, target)) {
            throw new Error(`Happy Agent ${label} path escapes its directory: ${relativePath}`);
        }
        await ensureSafeDirectory(dirname(target), label, directory);
        await replaceFile(target, file.contents, label);
        shipped.add(relativePath);
    }
    if (options.prune === true) await pruneUnshipped(directory, directory, shipped);
}

/** Remove what this release does not ship. A link is removed itself, never followed. */
async function pruneUnshipped(
    root: string,
    directory: string,
    shipped: ReadonlySet<string>,
): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const relativePath = relative(root, path);
        // Another start may be writing its replacement right now; it renames or removes its own.
        if (entry.isFile() && isTemporaryFile(entry.name)) continue;
        if (entry.isFile() && shipped.has(relativePath)) continue;
        if (
            entry.isDirectory() &&
            [...shipped].some((file) => file.startsWith(`${relativePath}${sep}`))
        ) {
            await pruneUnshipped(root, path, shipped);
            continue;
        }
        await rm(path, { force: true, recursive: true });
    }
}

function isTemporaryFile(name: string): boolean {
    return name.startsWith(".") && name.endsWith(".tmp");
}

function validateRelativePath(path: string, label: string): string {
    const normalized = normalize(path);
    if (
        path.length === 0 ||
        isAbsolute(path) ||
        normalized === ".." ||
        normalized.startsWith(`..${sep}`)
    ) {
        throw new Error(`Invalid Happy Agent ${label} path: ${path}`);
    }
    return normalized;
}

async function ensureSafeDirectory(
    path: string,
    label: string,
    root: string = path,
): Promise<void> {
    if (escapes(root, path)) {
        throw new Error(`Happy Agent ${label} directory escapes its root: ${path}`);
    }
    await createAndVerifyDirectory(root, label);
    const nested = relative(root, path);
    if (nested.length === 0) return;
    let current = root;
    for (const part of nested.split(sep)) {
        current = join(current, part);
        await createAndVerifyDirectory(current, label);
    }
}

async function createAndVerifyDirectory(path: string, label: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o755 });
    } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
    }
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error(`Happy Agent ${label} directory is unsafe: ${path}`);
    }
    await chmod(path, 0o755);
}

async function replaceFile(
    path: string,
    contents: string | Uint8Array,
    label: string,
): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o444 });
        await chmod(temporary, 0o444);
        // Windows cannot atomically replace a file while its read-only attribute is set.
        // Use a verified file handle so changing that attribute cannot follow a replaced link.
        const previous =
            process.platform === "win32" ? await openExistingFile(path, label) : undefined;
        const identity = await previous?.stat();
        if (previous) {
            try {
                await previous.chmod(0o644);
            } finally {
                // Windows rejects replacement while this handle is open.
                await previous.close();
            }
        }
        try {
            await rename(temporary, path);
        } catch (error) {
            if (identity) {
                const retained = await openExistingFile(path, label);
                if (retained) {
                    try {
                        const current = await retained.stat();
                        if (current.dev === identity.dev && current.ino === identity.ino) {
                            await retained.chmod(0o444);
                        }
                    } finally {
                        await retained.close();
                    }
                }
            }
            throw error;
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

async function openExistingFile(path: string, label: string) {
    const status = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    if (!status) return undefined;
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`Happy Agent ${label} file is unsafe: ${path}`);
    }
    const handle = await open(path, "r");
    try {
        const opened = await handle.stat();
        if (opened.dev !== status.dev || opened.ino !== status.ino || !opened.isFile()) {
            throw new Error(`Happy Agent ${label} file changed while opening: ${path}`);
        }
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function escapes(root: string, target: string): boolean {
    const path = relative(root, target);
    return path === ".." || path.startsWith(`..${sep}`);
}

function isAlreadyExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
