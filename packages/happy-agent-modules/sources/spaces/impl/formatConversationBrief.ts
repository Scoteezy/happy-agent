/** How much of the agent's last reply a brief quotes: enough to read the person's answer by. */
const AGENT_EXCERPT = 400;
/** How much of the person's own message a brief quotes. */
const PERSON_EXCERPT = 900;

/**
 * A short notice for Prioritizing about one turn in new work's conversation: what the agent last
 * said, and what the person wrote back, or how a session under the row stopped. Bounded well under
 * one stored brief, so a chatty conversation never crowds out everything else Prioritizing hears.
 * Every brief about one row starts with the same words, so older ones can be replaced.
 */
export function formatConversationBrief(input: {
    readonly rowId: string;
    /** A session under the row, when the turn happened there. */
    readonly sessionId?: string;
    readonly agentText: string | undefined;
    /** What the person wrote; absent when a session stopped without them. */
    readonly personText?: string;
}): string {
    const where =
        input.sessionId === undefined
            ? `row ${input.rowId}`
            : `session ${input.sessionId} under row ${input.rowId}`;
    const agent =
        input.agentText === undefined ? undefined : excerpt(input.agentText, AGENT_EXCERPT);
    if (input.personText === undefined)
        return `${conversationBriefPrefix(input.rowId)}: ${where} stopped. Its last reply: ${agent ?? "(nothing)"}`;
    return [
        `${conversationBriefPrefix(input.rowId)}: the person wrote in ${where}.`,
        ...(agent === undefined ? [] : [`Agent before it: ${agent}`]),
        `Person: ${excerpt(input.personText, PERSON_EXCERPT)}`,
    ].join("\n");
}

/** The words every conversation brief about one row starts with. */
export function conversationBriefPrefix(rowId: string): string {
    return `Conversation in ${rowId}`;
}

/** One line of text, cut at `limit` characters with an ellipsis. */
function excerpt(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}
