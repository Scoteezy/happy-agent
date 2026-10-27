import { join } from "node:path";

import { syncManagedDirectory, type ManagedFile } from "../managedFiles/syncManagedDirectory.js";

/**
 * Atomically synchronize one release's native skills into its managed Happy-home directory.
 *
 * Unlike documentation, a skill this release no longer ships is removed, so a renamed or retired
 * native skill stops being discovered instead of lingering from an earlier release.
 */
export async function syncHappyAgentNativeSkills(
    happyHome: string,
    files: readonly ManagedFile[],
): Promise<void> {
    await syncManagedDirectory(join(happyHome, "skills"), files, {
        label: "native skills",
        prune: true,
    });
}
