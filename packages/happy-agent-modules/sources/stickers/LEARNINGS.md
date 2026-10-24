# Stickers — learnings

## Packs are never bundled

The sticker art is a private archive. The module serves whatever the agent home's `stickers`
folder holds and ships nothing: no pack in the package, binary, installer, or repository. Tests
generate tiny packs of their own. How packs reach the folder is outside the API.

## The folder is the catalog

There is no import step and no database copy of a pack. The module reads the folder and reads
it again when its stamp changes, so adding, replacing, or removing a pack folder is all it takes.
A pack that fails validation or its file digests is left out rather than half-served.

## Lottie is computed on request and cached by digest

Clients that cannot read gzip ask for `?as=lottie`. The daemon gunzips a `tgs` file on the first
request, bounded to 16 MiB of output, and keeps the result under the file's digest, so later
requests and identical stickers in other packs reuse it.
