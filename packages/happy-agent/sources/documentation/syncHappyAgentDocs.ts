import { join } from "node:path";

import { readPackagedDirectory } from "../managedFiles/readPackagedDirectory.js";
import { syncHappyAgentDocumentation } from "./syncHappyAgentDocumentation.js";

/** Synchronize the documentation shipped beside this package into the configured Happy home. */
export async function syncHappyAgentDocs(
    happyHome: string,
    sourceDirectory?: string,
): Promise<void> {
    const candidates = sourceDirectory
        ? [sourceDirectory]
        : [
              join(import.meta.dirname, "..", "docs"),
              join(import.meta.dirname, "..", "..", "..", "..", "docs"),
          ];
    await syncHappyAgentDocumentation(
        happyHome,
        await readPackagedDirectory(candidates, "documentation"),
    );
}
