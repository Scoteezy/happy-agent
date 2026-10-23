import { readFileSync } from "node:fs";

/** The Bun version Happy Agent ships on, as pinned in the repository's mise.toml. */
export function pinnedBunVersion(): string {
    const tools = readFileSync(new URL("../mise.toml", import.meta.url), "utf8");
    const version = /^bun\s*=\s*"([^"]+)"/mu.exec(tools)?.[1];
    if (version === undefined) throw new Error("mise.toml does not pin a Bun version.");
    return version;
}
