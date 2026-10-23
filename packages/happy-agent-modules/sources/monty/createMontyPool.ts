import { Monty, type MontyOptions } from "@pydantic/monty/node";

import { resolveMontyBinary } from "./resolveMontyBinary.js";

/** Preserve each caller's runtime and recycling policy while selecting the owned native worker. */
export async function createMontyPool(options: MontyOptions): Promise<Monty> {
    return await Monty.create({ ...options, binaryPath: resolveMontyBinary(options.binaryPath) });
}
