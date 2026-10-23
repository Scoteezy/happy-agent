# Spaces tools

`prioritizingTools` is Prioritizing's complete tool array: `list_sidebar`,
`read_row_conversation`, `edit_sidebar`, `get_sidebar_styles`, `set_space_icon`, and the ordinary
artifact read/update tools. Layout edits are exact-text replacements of the sidebar document and
wait for the next calm moment; icons, for rows by space ID and for sessions by agent ID, apply
immediately. `read_row_conversation` returns what the person, the agent, and other agents writing
to it said in a row's or session's thread, newest first, without tool calls, capped at 40
messages and about 16,000 characters.

`request_space_placement` is offered to every root conversation. It only briefs Prioritizing;
when the person asked explicitly, Prioritizing's result applies as soon as it finishes.
