# Goal learnings

## A continuation carries the mutation of the run it continues

A goal continuation started its next run with no `mutationId`, so that run echoed nothing although
the run it continued answered a client's mutation. The continuation now carries that run's
mutation, read from History before the run settles. Each continuation passes it on, so the runs
of a goal started under a mutation keep echoing it as consequences of that request until other
accepted work starts a run that supersedes it, or the goal ends. A continuation after an external
activation follows no run and carries none.
