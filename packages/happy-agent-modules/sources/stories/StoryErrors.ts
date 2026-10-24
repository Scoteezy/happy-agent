import type { Story } from "@slopus/happy-agent-client";

/** A request that can never succeed as sent; the message says what to change. */
export class StoryInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StoryInputError";
    }
}

/**
 * No such story for this caller: it does not exist, they may not read it, or Stories is off for
 * them. The three are never told apart.
 */
export class StoryNotFoundError extends Error {
    constructor(message = "The story was not found.") {
        super(message);
        this.name = "StoryNotFoundError";
    }
}

/** The caller may read the story but only its author may do this. */
export class StoryForbiddenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StoryForbiddenError";
    }
}

/** The story is not in a state that allows this; it carries the story as the caller sees it now. */
export class StoryConflictError extends Error {
    readonly story: Story | undefined;

    constructor(message: string, story?: Story) {
        super(message);
        this.name = "StoryConflictError";
        this.story = story;
    }
}
