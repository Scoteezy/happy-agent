# Workflow learnings

## Daemon restart recovery

Agent Base restores active workflow collaborators before module `afterStart` runs. Workflow
startup must restore every durable running script and reattach each unanswered external call to
its persisted collaborator ID. Marking the run paused or creating a replacement agent loses the
live restoration edge and pays for the same call twice.

Register the recovered call's in-memory waiter before rereading its durable result. The restored
agent may settle while workflow startup is still rebuilding the script; the post-registration
read and settlement callback together cover both sides of that race without polling.

## Worker CPU budgets belong to Python segments, not whole workflows

The harness owns Monty's pool; Compute does not own these subprocesses. Code Mode and workflows
share a constructor that installs a POSIX hard CPU limit of 60 seconds, independent of the harness
and its native request watchdog. Every checkout receives a fresh worker. Workflows already dump
and close their session before awaiting an external function and restore it into a fresh checkout
afterward, so neither external-call waiting nor earlier segments consumes the next segment's CPU
allowance. A killed harness can leave an in-flight worker briefly, but not an unlimited CPU loop.
Windows retains its existing native watchdog. Cancellation is checked before executing Python and
after external awaits; in-flight requests settle under their existing execution/request budgets.

## Agents a run starts answer the mutation of the run that launched it

A workflow's agents were created through Collaboration, which read the owner's current run when
each agent started. The owner may have settled and started another run by then, so a later agent
answered that run's `mutationId`. The launch now records the launching run's mutation, from
History's `runMutationId`, and passes it to every `createAgent` call, `null` when there was none,
so a restored run keeps it too.
