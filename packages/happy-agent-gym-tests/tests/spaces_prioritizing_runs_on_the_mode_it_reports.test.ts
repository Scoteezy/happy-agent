import { GYM_MODEL_ID, GYM_SECOND_MODEL_ID, runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

type Gym = Awaited<ReturnType<typeof sidebarGym>>;

/** Prioritizing's inference requests, oldest first. */
const runs = (h: Gym, prioritizing: string) =>
    h.gym.inference.requests.filter((request) => request.sessionId === prioritizing);

/** The request of the wake a person's sidebar change causes, an ordinary notice. */
async function wakeOnPersonsChange(h: Gym, prioritizing: string, mutationId: string) {
    const before = runs(h, prioritizing).length;
    const current = await h.read();
    await h.gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: current.html.replace("</nav>", `  <happy-separator id="${mutationId}"/>\n</nav>`),
        baseVersion: current.version,
        mutationId,
    });
    const woken = await h.gym.waitUntil(
        () =>
            runs(h, prioritizing)
                .slice(before)
                .find((request) =>
                    JSON.stringify(request.messages).includes(
                        "Here is what changed since your last notice.",
                    ),
                ),
        "the notice wake",
    );
    await h.settle();
    return woken;
}

const mode = async (h: Gym, prioritizing: string) =>
    (
        await h.gym.http.ok<{ mode: { modelId: string; effort: string } }>(
            "GET",
            `/v0/agents/${prioritizing}/mode`,
        )
    ).mode;

it("runs Prioritizing's notice wakes on the mode the person chose in its conversation", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const prioritizing = await h.manager();
        // Made on the default model from Settings, here the catalog's first.
        expect(runs(h, prioritizing)[0]?.model).toBe(GYM_MODEL_ID);
        await h.settle();
        await h.unseed();
        await h.settle();

        await h.gym.send("Use the other model from now on.", {
            sessionId: prioritizing,
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        expect(await mode(h, prioritizing)).toMatchObject({
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        expect(await wakeOnPersonsChange(h, prioritizing, "first")).toMatchObject({
            model: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        expect(await mode(h, prioritizing)).toMatchObject({
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("runs a notice wake on the reported mode even when an earlier notice ran on another model", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const prioritizing = await h.manager();
        await h.settle();
        await h.unseed();
        await h.settle();
        // The state an older daemon left: the person chose the second model, but its notices
        // went on running on the default model, so that is what the conversation last ran on.
        const chosen = {
            providerId: h.gym.selection.providerId,
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
            serviceTier: null,
            permissionMode: "auto",
        };
        await h.gym.restart({
            whileStopped: async () =>
                await runGymSql(h.gym.happyHome, [
                    `UPDATE happy_agent_values SET value_json = json_set(value_json, '$.metadata.lastMode', json('${JSON.stringify(chosen)}')) WHERE owner_id = '${prioritizing}' AND key = 'agentConfig'`,
                ]),
        });
        await h.read();
        expect(await mode(h, prioritizing)).toMatchObject({
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        expect(await wakeOnPersonsChange(h, prioritizing, "after-restart")).toMatchObject({
            model: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
    } finally {
        await h.gym.dispose();
    }
}, 120000);
