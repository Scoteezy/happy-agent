import type { StoryPerson } from "../StoryRecords.js";

/** How far back closeness and interest look. */
export const RANKING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const FRESHNESS_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
const WORK_WEIGHT = 2;
const AUTHOR_WEIGHT = 1.5;
const INTEREST_WEIGHT = 1;
const FRESHNESS_WEIGHT = 1;
/** Shared conversations past this many add no more closeness. */
const SHARED_CONVERSATIONS_CAP = 10;

export interface RankedStory {
    readonly sourceAgentId: string | undefined;
    readonly postedAt: number;
}

export interface RankedAuthor {
    readonly person: StoryPerson;
    readonly stories: readonly RankedStory[];
    readonly unseen: number;
    readonly latestPostedAt: number;
}

export interface RankingSignals {
    readonly now: number;
    /** The conversations the viewer wrote in within the window. */
    readonly viewerConversations: ReadonlySet<string>;
    /** The conversations each author wrote in within the window. */
    readonly authorConversations: ReadonlyMap<StoryPerson, ReadonlySet<string>>;
    /** Of each author's stories posted within the window, the share the viewer has seen. */
    readonly interest: ReadonlyMap<StoryPerson, number>;
}

/**
 * Order other authors for one viewer: those with an unseen story first, then the rest, and by
 * importance and then newest story within each group. An author's importance is their most
 * important story's: closeness of its work, closeness of its author, interest, and freshness.
 * Deterministic: equal authors fall back to their person key.
 */
export function rankAuthors(
    authors: readonly RankedAuthor[],
    signals: RankingSignals,
): RankedAuthor[] {
    const importance = new Map(authors.map((author) => [author.person, score(author, signals)]));
    return [...authors].sort((left, right) => {
        const group = Number(right.unseen > 0) - Number(left.unseen > 0);
        if (group !== 0) return group;
        const weight = (importance.get(right.person) ?? 0) - (importance.get(left.person) ?? 0);
        if (weight !== 0) return weight;
        if (right.latestPostedAt !== left.latestPostedAt) {
            return right.latestPostedAt - left.latestPostedAt;
        }
        return left.person < right.person ? -1 : left.person > right.person ? 1 : 0;
    });
}

function score(author: RankedAuthor, signals: RankingSignals): number {
    const theirs = signals.authorConversations.get(author.person) ?? new Set<string>();
    let shared = 0;
    for (const agentId of theirs) if (signals.viewerConversations.has(agentId)) shared += 1;
    const closeness = Math.min(shared, SHARED_CONVERSATIONS_CAP) / SHARED_CONVERSATIONS_CAP;
    const interest = signals.interest.get(author.person) ?? 0;
    let best = 0;
    for (const story of author.stories) {
        const work =
            story.sourceAgentId !== undefined &&
            signals.viewerConversations.has(story.sourceAgentId)
                ? 1
                : 0;
        const freshness =
            0.5 ** (Math.max(0, signals.now - story.postedAt) / FRESHNESS_HALF_LIFE_MS);
        best = Math.max(
            best,
            WORK_WEIGHT * work +
                AUTHOR_WEIGHT * closeness +
                INTEREST_WEIGHT * interest +
                FRESHNESS_WEIGHT * freshness,
        );
    }
    return best;
}
