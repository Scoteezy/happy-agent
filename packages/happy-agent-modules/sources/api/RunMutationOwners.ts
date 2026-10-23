/**
 * @internal The client mutation each agent's current run answers.
 *
 * An agent loop keeps the async chain of whatever request woke it for its whole life, so agent
 * events echo the agent's run rather than their chain. A run records its mutation when it starts
 * and gives it up when it settles, and nothing else removes it: an owner lives exactly as long as
 * its run, so there is at most one per agent with a run in progress that answers a mutation.
 */
export class RunMutationOwners {
    readonly #owners = new Map<string, { readonly runId: string; readonly mutationId: string }>();

    /** How many runs in progress answer a mutation. */
    get size(): number {
        return this.#owners.size;
    }

    /** The agent's run `runId` starts, answering `mutationId`, or none. */
    start(agentId: string, runId: string, mutationId: string | undefined): void {
        if (mutationId === undefined) this.#owners.delete(agentId);
        else this.#owners.set(agentId, { runId, mutationId });
    }

    /** The agent's run `runId` settled; a successor run that already replaced it stays. */
    settle(agentId: string, runId: string | undefined): void {
        if (this.#owners.get(agentId)?.runId === runId) this.#owners.delete(agentId);
    }

    /** The mutation the agent's current run answers. */
    mutationId(agentId: string): string | undefined {
        return this.#owners.get(agentId)?.mutationId;
    }
}
