# Goal learnings

## A continuation carries the mutation of the run it continues

A goal continuation started its next run with no `mutationId`, so that run echoed nothing although
the run it continued answered a client's mutation. The continuation now carries that run's
mutation, read from History before the run settles. Each continuation passes it on, so every run
of a goal started under a mutation echoes it until the goal ends; a continuation after an
external activation follows no run and carries none.
