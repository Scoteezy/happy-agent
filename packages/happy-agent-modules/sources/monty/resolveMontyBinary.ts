import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findMontyBinary } from "@pydantic/monty/node";

/** Source and dist share one module-owned native artifact; standalone builds embed it. */
export function resolveMontyBinary(explicit?: string): string {
    const configured = explicit ?? process.env.MONTY_BIN;
    if (configured !== undefined) return findMontyBinary(configured);

    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "monty.exe" : "monty";
    const path = fileURLToPath(new URL(`../../native/target/${key}/${filename}`, import.meta.url));
    if (!existsSync(path)) {
        throw new Error(
            "The native Python worker has not been built for this computer. " +
                "Run pnpm --filter @slopus/happy-agent build:native:monty before using Python workflows or Code Mode from source.",
        );
    }
    return path;
}
