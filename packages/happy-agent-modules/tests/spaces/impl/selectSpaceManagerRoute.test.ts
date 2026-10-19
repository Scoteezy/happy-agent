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
        expect(selectSpaceManagerRoute(MODELS, "codex")).toEqual({
            providerId: "codex",
            model: "openai/gpt-6-luna",
            effort: "low",
        });
        expect(selectSpaceManagerRoute(MODELS, "claude")).toEqual({
            providerId: "claude",
            model: "anthropic/haiku-5-5",
            effort: "off",
        });
    });

    it("falls back to the installation's default account when Happy's is unknown", () => {
        expect(selectSpaceManagerRoute(MODELS, undefined)).toEqual({
            providerId: "codex",
            model: "openai/gpt-6-luna",
            effort: "low",
        });
    });
});
