# Happy agent gym — learnings

## An in-process restart is a graceful stop, never a crash

`gym.restart()` closes the daemon inside the test process and starts another on the same folder.
It cannot simulate a crash: nothing kills the process, so every lock and handle the first daemon
holds is released only if its `close()` releases it. Graceful shutdown gives its handlers ten
seconds. A handler still waiting then — for example the agent system waiting on a foreground
command that runs longer — is abandoned, and the main SQLite database and its process lock stay
open. The next daemon then fails with "The Happy agent SQLite database is already open in another
process."

Production does not meet this, because the daemon is its own process: `runAgentDaemon` hard-exits
once shutdown settles, timed out or not, and the kernel releases the lock. A reload drains first,
which lets foreground commands finish, and starts the replacement only after the old process has
exited. Only a daemon embedded with `persistPid: false`, which tests use, skips the hard exit.

A gym scenario that restarts across a foreground command must therefore use a command that
finishes within the shutdown budget. Recovery from a true crash belongs in a test that runs the
daemon as a separate process.
