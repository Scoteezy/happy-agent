# Transport learnings

## An SSE writer cannot wait for `drain` alone

A client waiting on `/v0/events/stream` for a run's `run.finished` hung forever, even though the
daemon had journaled the event and replayed it to that connection. The SSE writer queued frames
after `response.write()` reported backpressure and resumed only on the response's `drain`. Node 26
corks a response for the rest of the tick and measures that buffer, headers and chunk framing
included, against the high-water mark. A synchronous replay burst can therefore cross the mark
while the socket, after the kernel takes the first bytes, stays below its own. The socket never
needs `drain`, so the response never emits it, and every remaining frame stayed queued. A replay
that follows a manual compaction is large enough to hit this reliably under load.

The writer now also counts each frame's write callback, and resumes once every frame it handed to
Node has been flushed, whichever of the two signals comes first. The byte bounds and whole-frame
ordering are unchanged.
