import { join } from "node:path";

import { readPackagedDirectory } from "../managedFiles/readPackagedDirectory.js";
import { syncHappyAgentNativeSkills } from "./syncHappyAgentNativeSkills.js";

/** Synchronize the native skills shipped beside this package into the configured Happy home. */
export async function syncHappyAgentSkills(
    happyHome: string,
    sourceDirectory?: string,
): Promise<void> {
    const candidates = sourceDirectory
        ? [sourceDirectory]
        : [
              join(import.meta.dirname, "..", "skills"),
              join(import.meta.dirname, "..", "..", "..", "..", "skills"),
          ];
    await syncHappyAgentNativeSkills(
        happyHome,
        await readPackagedDirectory(candidates, "native skills"),
    );
}
