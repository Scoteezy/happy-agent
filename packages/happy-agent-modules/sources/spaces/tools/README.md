# Spaces tools

`prioritizingTools` is Prioritizing's complete tool array: `list_sidebar`, `read_conversations`,
`edit_sidebar`, `propose_sidebar`, `get_sidebar_styles`, `set_space_icon`, and the ordinary
artifact read/update tools. Layout edits are exact-text replacements of the sidebar document and
wait for the end of Prioritizing's turn; only small changes apply that way, and `propose_sidebar`
drafts or revises a proposal the person accepts, returning it as an inline artifact presentation.
Icons, for rows by space ID and for sessions by agent ID, apply immediately.
`read_conversations` reads up to twelve rows or sessions at once, each as its latest turns
oldest first, without tool calls, bounded per message, conversation, and answer.

`request_space_placement` is offered to every root conversation. It only briefs Prioritizing;
when the person asked explicitly, Prioritizing's result applies as soon as it finishes.

`attach_to_my_row` is offered to a conversation with a row, or a session under one, in the sidebar of
a person with Stem Cells on. It attaches one of the person's rows, an existing todo, document,
calendar, or chat Surface, or a new one, under the caller's row at once, authored as Prioritizing.
