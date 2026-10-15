# Deterministic file-lock boundary probes

Status: implemented
Translation: current

[中文](2026-10-15-file-lock-boundary-harness.zh.md)

## Abstract

Session startup errors can conflate queued work, failed cleanup and deadlock.
This harness executes the complete current file-lock source with its pinned
Effect runtime, an in-memory filesystem and a virtual clock. It demonstrates
that local queue waiting is outside the acquisition timeout, and separately
that delayed cleanup can return `LockReleaseFailed` before its original unlink
finishes. Controls drain both cases; this establishes documented boundaries,
not a new circular deadlock or the cause of a production outage.

## Run and provenance

```sh
cd scripts/diagnostics/file-lock
npm ci --ignore-scripts --workspaces=false
npm run probe --silent
```

Installation provisions the single locked dependency, Effect 4.0.2, and may need
network access. The experiment itself is offline and uses no real sleeps or
performance thresholds. Use the repository-supported Node runtime with
`stripTypeScriptTypes` and `--experimental-vm-modules` support. No monorepo
installation is needed. `results.json` records the synthetic measurements.

The source base is `a06a69f3e96eec68751ebd4df1d050cbbc4f1cea`; the result includes
the SHA-256 of `packages/shared/src/node/file-lock.ts`. The harness erases types
and links the complete module to explicit filesystem/process capabilities.
It does not reconstruct the queue or alter the lock algorithm. Run only trusted
source: the VM is not a security boundary. The unused production filesystem
layer and process facade are replaced, so module composition cannot access
real locks, PIDs or the installation store.

## Hypotheses and execution packet

The parent designed these experiments; an independent `alchemist` ran them.
The history and lock experiments were executed sequentially.

1. A holder retains a named lock while a second caller requests a 120-second
   acquisition timeout. After 600 seconds of virtual time, the caller remains
   queued. An unrelated lock proceeds. Releasing the holder drains the original
   queue in order and leaves no files. A deadline failure while queued would
   falsify this scope claim; failure to drain would invalidate the control.
2. The body succeeds but its synthetic unlink is held behind a Deferred. After
   the five-second cleanup deadline, the caller receives `LockReleaseFailed`
   while the raw release still owns the file. Completing that original unlink
   permits a subsequent acquisition and clears all files. Immediate cleanup
   succeeds as a negative control. Missing failure, lost ownership, or failed
   recovery would falsify the proposed lifecycle behaviour.

All predicted observations and controls passed. No raw task is abandoned after
the experiment. Failed cleanup is completed, rather than deleting a real lock
or starting a competing release.

## Interpretation and alternatives

These are intentional behaviours already covered in
`packages/shared/tests/file-lock.test.ts` and explained by the owning
[lifecycle note](../architecture/2026-10-10-effect-file-lock-lifecycle.md).
The harness makes them independently runnable without the full application.
It changes no lock policy and does not propose timing out a live holder.

This corrects an overly broad diagnosis: a two-minute acquisition setting does
not promise a two-minute total startup deadline. A cleanup timeout can explain
the error class, but a gated unlink does not reproduce CPU starvation or prove
the observed production error had that cause. No circular lock dependency was
demonstrated. The separate history-work harness measures a different mechanism;
neither experiment validates the older presence-queue hypothesis on a new SDK.

Real daemon logs, conversation data and credentials are excluded. Further
incident attribution needs the production error's complete nested cause and
correlated traces; changing global timeouts is outside this diagnostic's scope.
