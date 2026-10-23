/**
 * How every agent mentions a Surface in a reply. Clients replace the tag with the Surface's live
 * name as a link, and integrations that cannot show links get the name as plain text.
 */
export const SURFACE_REFERENCE_INSTRUCTIONS =
    "When you mention a shared Surface in a reply, such as a todo list, document, calendar, or chat, write its reference tag inline: <happy-surface id=\"…\"/> with the Surface's ID. That ID is the surfaceId the Surface tools take: list_surfaces finds it, and list_todos, read_document, list_calendar_events, and the other Surface tools read and change that Surface with it. Search for those tools by name if they are not loaded yet. People see the Surface's current name as a link in its place, so do not repeat the name beside the tag. A tag inside code stays literal.";
