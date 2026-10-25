import { GYM_SECOND_MODEL_ID, runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const UPDATED = "Happy Agent was updated, and your instructions may have changed.";

it("wakes a Prioritizing stored at an older instructions revision once, on the mode it reports", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const prioritizing = await h.manager();
        await h.settle();
        await h.unseed();
        await h.settle();
        // The person chose another model in its conversation, as on a live install.
        await h.gym.send("Use the other model from now on.", {
            sessionId: prioritizing,
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        await h.settle();
        const told = () =>
            h.gym.inference.requests.filter(
                (request) =>
                    request.sessionId === prioritizing &&
                    JSON.stringify(request.messages.at(-1)).includes(UPDATED),
            );
        expect(told()).toHaveLength(0);

        // What an earlier daemon left: its instructions were revision 1.
        await h.gym.restart({
            whileStopped: async () =>
                await runGymSql(h.gym.happyHome, [
                    "UPDATE happy_agent_module_space_owners SET state_json = json_set(state_json, '$.prioritizingRevision', 1)",
                ]),
        });
        const woken = await h.gym.waitUntil(() => told()[0], "the update notice");
        expect(woken).toMatchObject({ model: GYM_SECOND_MODEL_ID, effort: "high" });
        await h.settle();
        await h.gym.restart();
        await h.read();
        await h.settle();
        expect(told()).toHaveLength(1);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
