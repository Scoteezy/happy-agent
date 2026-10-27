import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const repositoryDocs = join(packageRoot, "..", "..", "docs");
const packagedDocs = join(packageRoot, "dist", "docs");
const repositorySkills = join(packageRoot, "..", "..", "skills");
const packagedSkills = join(packageRoot, "dist", "skills");

await rm(packagedDocs, { force: true, recursive: true });
await cp(repositoryDocs, packagedDocs, { recursive: true });
await cp(join(packageRoot, "API.md"), join(packagedDocs, "API.md"));
await cp(join(packageRoot, "API_P2P.md"), join(packagedDocs, "API_P2P.md"));

// Native skills ship beside the documentation and are installed the same way.
await rm(packagedSkills, { force: true, recursive: true });
await cp(repositorySkills, packagedSkills, { recursive: true });
