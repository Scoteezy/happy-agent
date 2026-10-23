import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import { MutationAwareApiEventJournal, type MutationScope } from "../../sources/api/ApiModule.js";

const request = (mutationId: string | undefined): MutationScope => ({ mutationId, inLoop: false });

describe("MutationAwareApiEventJournal", () => {
    it("keeps concurrent mutation identifiers in their own async chains", async () => {
        const mutationIds = new AsyncLocalStorage<MutationScope>();
        const journal = new MutationAwareApiEventJournal(mutationIds);
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        await Promise.all([
            mutationIds.run(request("first"), async () => {
                await firstMayFinish;
                journal.append("project.updated", { projectId: "p1" });
            }),
            mutationIds.run(request("second"), async () => {
                journal.append("workspace.updated", { workspaceId: "w1" });
                releaseFirst();
            }),
        ]);
        journal.append("git.updated", { workspaceId: "w1" });

        const payloads = journal
            .replay(undefined, undefined, 10)
            ?.events.map((event) => event.payload);
        expect(payloads).toEqual([
            { workspaceId: "w1", mutationId: "second" },
            { projectId: "p1", mutationId: "first" },
            { workspaceId: "w1" },
        ]);
    });

    it("keeps delayed background invalidations mutationless inside a mutation async chain", () => {
        const mutationIds = new AsyncLocalStorage<MutationScope>();
        const journal = new MutationAwareApiEventJournal(mutationIds);

        mutationIds.run(request("direct-mutation"), () => {
            journal.append("example.updated", { version: "direct" });
            journal.appendOutsideMutation("example.updated", { version: "background" });
        });

        expect(
            journal.replay(undefined, undefined, 10)?.events.map((event) => event.payload),
        ).toEqual([
            { mutationId: "direct-mutation", version: "direct" },
            { version: "background" },
        ]);
    });

    it("echoes nothing on its own once the chain runs an agent loop", () => {
        const mutationIds = new AsyncLocalStorage<MutationScope>();
        const journal = new MutationAwareApiEventJournal(mutationIds);
        const chain = request("wake-mutation");

        mutationIds.run(chain, () => {
            journal.append("git.updated", { workspaceId: "w1" });
            chain.inLoop = true;
            journal.append("agent.updated", { agentId: "a1" });
        });

        expect(
            journal.replay(undefined, undefined, 10)?.events.map((event) => event.payload),
        ).toEqual([{ mutationId: "wake-mutation", workspaceId: "w1" }, { agentId: "a1" }]);
    });
});
