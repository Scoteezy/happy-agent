import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const STORIES = "happy-desktop.experiments.stories";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** Every route a person with Stories off must find missing, as on a daemon without Stories. */
const HIDDEN_ROUTES = [
    "/v0/stories",
    "/v0/stories/feed",
    "/v0/stories/media?agentId=a0000000000000000000000",
    "/v0/stories/s0000000000000000000000",
    "/v0/stickers/packs",
    "/v0/stickers/recents",
    "/v0/stickers/search?q=duck",
];

async function expectHidden(gym: AgentGym): Promise<void> {
    for (const path of HIDDEN_ROUTES) {
        const response = await gym.http.get<{ code: string }>(path);
        expect({ path, status: response.status, code: response.body.code }).toEqual({
            path,
            status: 404,
            code: "not_found",
        });
    }
    const post = await gym.http.post("/v0/stories", {
        frames: [{ asset: { type: "chat_media", agentId: "a0", toolCallId: "c0", index: 0 } }],
    });
    expect(post.status).toBe(404);
}

describe("Stories stay hidden until the person turns them on", () => {
    it("serves no route, offers no tool, and changes no prompt until the setting is exactly true", async () => {
        const gym = await createAgentGym({
            inference: () => ({ content: [{ type: "text", text: "Done." }] }),
        });
        running.push(gym);

        // The capability is reported either way; the routes still answer as if absent.
        expect((await gym.client.getHealth()).capabilities).toMatchObject({
            stories: true,
            stickers: true,
        });
        await expectHidden(gym);

        await gym.send("Hello.");
        const before = gym.inference.last!;
        expect(gym.inference.lastTools()).not.toContain("draft_story");

        await gym.client.saveUserSetting(STORIES, { value: true });
        await gym.send("Again.");
        expect(gym.inference.lastTools()).toContain("draft_story");
        const feed = await gym.client.getStoryFeed();
        expect(feed.authors).toEqual([
            expect.objectContaining({ isSelf: true, userId: null, storyIds: [], draftCount: 0 }),
        ]);
        expect(await gym.client.getStickerRecents()).toEqual({
            recents: [],
            cursor: expect.any(String),
        });

        // Anything but the JSON boolean true is off.
        for (const value of ["true", 1, { on: true }, false]) {
            await gym.client.saveUserSetting(STORIES, { value });
            await expectHidden(gym);
        }
        await gym.send("Once more.");
        const after = gym.inference.last!;
        expect(gym.inference.lastTools()).not.toContain("draft_story");
        // Byte for byte, the model is offered what it was offered before Stories was ever on.
        expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
        expect(after.instructions).toBe(before.instructions);

        // Turning it off produced no story events for anyone.
        const events = (await gym.client.getEvents({ limit: 1_000 })).events;
        expect(events.filter((event) => event.type.startsWith("story."))).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
