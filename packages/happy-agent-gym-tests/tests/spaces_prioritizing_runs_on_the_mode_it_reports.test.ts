import { GYM_MODEL_ID, GYM_SECOND_MODEL_ID } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("runs Prioritizing's wakes on the mode it reports, after the person chose another model for it", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const prioritizing = await h.manager();
        const runs = () =>
            h.gym.inference.requests.filter((request) => request.sessionId === prioritizing);
        // Made on the default model from Settings, here the catalog's first.
        expect(runs()[0]?.model).toBe(GYM_MODEL_ID);
        await h.settle();

        // The person picks another model and effort in Prioritizing's own conversation.
        await h.gym.send("Use the other model from now on.", {
            sessionId: prioritizing,
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        const mode = async () =>
            (
                await h.gym.http.ok<{ mode: { modelId: string; effort: string } }>(
                    "GET",
                    `/v0/agents/${prioritizing}/mode`,
                )
            ).mode;
        expect(await mode()).toMatchObject({ modelId: GYM_SECOND_MODEL_ID, effort: "high" });

        // A wake keeps that mode instead of switching back to the default model.
        const before = runs().length;
        await h.gym.http.ok("POST", "/v0/spaces/tidy", {});
        const woken = await h.gym.waitUntil(
            () =>
                runs()
                    .slice(before)
                    .find((request) =>
                        JSON.stringify(request.messages).includes("Tidy the sidebar now"),
                    ),
            "the tidy wake",
        );
        expect(woken).toMatchObject({ model: GYM_SECOND_MODEL_ID, effort: "high" });
        await h.settle();
        expect(await mode()).toMatchObject({ modelId: GYM_SECOND_MODEL_ID, effort: "high" });
    } finally {
        await h.gym.dispose();
    }
}, 120000);
