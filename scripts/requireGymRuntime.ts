import { pinnedBunVersion } from "./pinnedBunVersion.js";

// The gym proves the daemon on the runtime it ships on: the Bun pinned in mise.toml. This setup
// file runs inside every Vitest worker, because checking only the launcher would miss a worker
// that silently started under Node, where real terminals cannot open. The Node lane opts out
// deliberately with HAPPY_GYM_RUNTIME=node and is then held to Node just as strictly.
const runtime = process.env.HAPPY_GYM_RUNTIME ?? "bun";

if (runtime === "node") {
    if (process.versions.bun !== undefined) {
        throw new Error(
            `This gym worker belongs to the Node lane but runs on Bun ${process.versions.bun}.`,
        );
    }
} else if (runtime === "bun") {
    const pinned = pinnedBunVersion();
    if (process.versions.bun === undefined) {
        throw new Error(
            `The gym runs on Bun ${pinned}, the Happy Agent runtime, but this worker runs on ` +
                `Node ${process.version}. Run it with the package's \`vitest:bun\` script, or ` +
                "set HAPPY_GYM_RUNTIME=node for a deliberate Node run.",
        );
    }
    if (process.versions.bun !== pinned) {
        throw new Error(
            `The gym runs on the pinned Bun ${pinned}, but this worker runs on Bun ` +
                `${process.versions.bun}.`,
        );
    }
} else {
    throw new Error(`HAPPY_GYM_RUNTIME must be "bun" or "node", not "${runtime}".`);
}
