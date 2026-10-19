import type { AgentModel } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { selectSpaceManagerRoute } from "../../../sources/spaces/impl/selectSpaceManagerRoute.js";

const model = (providerId: string, id: string, effortLevels: string[]): AgentModel =>
    ({ providerId, id, name: id, effortLevels, defaultEffort: effortLevels.at(-1) }) as AgentModel;

const MODELS = [
    model("codex", "openai/gpt-5.6-sol", ["low", "medium", "high"]),
    model("codex", "openai/gpt-6-luna", ["low", "medium"]),
    model("claude", "anthropic/opus-5-5", ["low", "high"]),
    model("claude", "anthropic/haiku-5-5", ["off", "low"]),
];

describe("selectSpaceManagerRoute", () => {
    it("runs on the cheapest model of Happy's own account at the least effort", () => {
        expect(selectSpaceManagerRoute(MODELS, undefined, "codex")).toEqual({
            providerId: "codex",
            model: "openai/gpt-6-luna",
            effort: "low",
        });
        expect(selectSpaceManagerRoute(MODELS, undefined, "claude")).toEqual({
            providerId: "claude",
            model: "anthropic/haiku-5-5",
            effort: "off",
        });
    });

    it("uses the configured model while it is offered, and falls back when it is not", () => {
        expect(
            selectSpaceManagerRoute(
                MODELS,
                { providerId: "claude", modelId: "anthropic/opus-5-5", effort: "high" },
                "codex",
            ),
        ).toEqual({ providerId: "claude", model: "anthropic/opus-5-5", effort: "high" });
        expect(
            selectSpaceManagerRoute(
                MODELS,
                { providerId: "claude", modelId: "anthropic/retired" },
                undefined,
            ),
        ).toEqual({ providerId: "codex", model: "openai/gpt-6-luna", effort: "low" });
    });
});
