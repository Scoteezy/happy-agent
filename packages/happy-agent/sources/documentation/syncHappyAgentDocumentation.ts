import { join } from "node:path";

import { syncManagedDirectory, type ManagedFile } from "../managedFiles/syncManagedDirectory.js";

/** Atomically synchronize one release's documentation into its managed Happy-home directory. */
export async function syncHappyAgentDocumentation(
    happyHome: string,
    files: readonly ManagedFile[],
): Promise<void> {
    await syncManagedDirectory(join(happyHome, "docs"), files, { label: "documentation" });
}
