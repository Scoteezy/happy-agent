import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SkillsModule } from "../../sources/skills/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";

const ctx = createRootContext().named("skills-builtin-test");
const agentId = "agent";

function skill(name: string, description: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}`;
}

async function nativeMachine() {
    const config = await temporaryTestConfig();
    const builtin = config.configuration.paths.skillsHome;
    const machine = new FakeCompute("/workspace");
    machine.directories.add("/workspace/.git");
    machine.write(join(builtin, "guided-review", "SKILL.md"), skill("guided-review", "Shipped."));
    const compute = scriptedComputeModule(async () => machine);
    vi.spyOn(compute, "fileSystemIdentity").mockReturnValue("native-test");
    return { builtin, config, machine, module: new SkillsModule(compute, undefined, config) };
}

describe("native skills", () => {
    it("discovers the shipped skills folder as builtin skills on the native filesystem", async () => {
        const { builtin, module } = await nativeMachine();

        await expect(module.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Shipped.",
                    location: join(builtin, "guided-review", "SKILL.md"),
                    name: "guided-review",
                    source: "builtin",
                },
            ],
        });
        await expect(module.read(ctx, agentId, { name: "guided-review" })).resolves.toMatchObject({
            content: expect.stringContaining("Shipped."),
        });
    });

    it("lets a project or user skill of the same name replace the builtin one", async () => {
        const { machine, module } = await nativeMachine();
        machine.write(
            "/home/agent/.agents/skills/guided-review/SKILL.md",
            skill("guided-review", "Installed by the user."),
        );

        await expect(module.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Installed by the user.",
                    location: "/home/agent/.agents/skills/guided-review/SKILL.md",
                    name: "guided-review",
                    source: "user",
                },
            ],
        });

        machine.write(
            "/workspace/.agents/skills/guided-review/SKILL.md",
            skill("guided-review", "Owned by the project."),
        );
        await expect(module.list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ description: "Owned by the project.", source: "project" }],
        });
    });

    it("does not offer native skills to a machine other than the daemon's own", async () => {
        const { config, machine } = await nativeMachine();
        const remote = new SkillsModule(
            scriptedComputeModule(async () => machine),
            undefined,
            config,
        );

        await expect(remote.list(ctx, agentId)).resolves.toEqual({ skills: [] });
    });
});
