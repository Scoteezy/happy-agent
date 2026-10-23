import { describe, expect, it } from "vitest";

import { RunMutationOwners } from "../../sources/api/RunMutationOwners.js";

describe("RunMutationOwners", () => {
    it("keeps a run's mutation until that run settles, however many other runs start", () => {
        const owners = new RunMutationOwners();
        owners.start("long", "long-run", "long-echo");
        for (let index = 0; index < 20_000; index += 1) {
            owners.start(`agent-${String(index)}`, `run-${String(index)}`, `echo-${String(index)}`);
        }

        expect(owners.mutationId("long")).toBe("long-echo");
        owners.settle("long", "long-run");
        expect(owners.mutationId("long")).toBeUndefined();
    });

    it("hands an agent's echo to its next run, and to none when that run answers none", () => {
        const owners = new RunMutationOwners();
        owners.start("agent", "first", "first-echo");
        owners.start("agent", "successor", "successor-echo");
        // The first run's late settlement does not end the successor that replaced it.
        owners.settle("agent", "first");
        expect(owners.mutationId("agent")).toBe("successor-echo");

        owners.start("agent", "untagged", undefined);
        expect(owners.mutationId("agent")).toBeUndefined();
        expect(owners.size).toBe(0);
    });

    it("keeps only runs that answer a mutation", () => {
        const owners = new RunMutationOwners();
        for (let index = 0; index < 100; index += 1) {
            owners.start(`agent-${String(index)}`, `run-${String(index)}`, undefined);
        }
        owners.start("tagged", "tagged-run", "echo");

        expect(owners.size).toBe(1);
    });
});
