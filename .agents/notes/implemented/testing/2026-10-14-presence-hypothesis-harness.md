# Deterministic legacy presence transport probes

Status: implemented
Translation: current

[中文](2026-10-14-presence-hypothesis-harness.zh.md)

## Abstract

A diagnostic harness probes whether same-key replacement can starve machine
presence and whether error-body reads outlive the installed transport deadline.
It executes selected methods from an explicitly supplied trusted compiled bundle,
with synthetic queue entries, acknowledgements, responses and clocks. Controls
remove replacement, preserve queue position, release the error body, or retain a
body deadline. Results establish mechanisms for that artifact and schedule;
they do not establish a production incident's cause or newer SDK behavior.

## Run and ownership

From the repository root:

```sh
node scripts/probe-presence-hypotheses.mjs --bundle /path/to/trusted/cli/dist/index.js
```

The command prints the bundle SHA-256, measurements and reproduction/falsification
verdicts as JSON. No dependencies need installing. It does not import the bundle,
read runtime credentials or conversations, contact services, invoke real timers,
or start an application. Selected method declarations are evaluated in a VM;
that VM is not a security boundary for untrusted input. Extraction requires the
known legacy compiled layout and fails explicitly for unsupported artifacts.

Queue acknowledgements are scheduled explicitly. The slow-writer schedule refreshes
the machine key between sends, while two session keys keep participating. The
position-preserving variant is a sensitivity ablation, not a proposed product fix.
The body probe controls response headers and body completion separately; its
synthetic clock advances beyond the request deadline without elapsed-time assertions.
Every controlled body promise is settled after observation.

## Interpretation

An unresolved captured barrier is distinguished from later independent writes.
Logical pending counts are distinguished from physical live entries. The
deadline probe examines the SDK-owned timer; it makes no claim about lower
transport timeouts. Normal finite-body and successful-response controls must pass.
Unsupported layouts or broken controls fail; a supported implementation that
does not exhibit a mechanism reports falsification for that scenario.

This concerns the transport budget documented in
[CLI presence](../../../docs/cli-lib-loro-presence.md), not application lifecycle
ownership. Native Effect transport has a different interface and requires its own
adapter; this harness does not claim to test it. Verification results belong to
the externally supplied artifact identified in the command output.

## Verification

The recorded [results JSON](../../../../scripts/presence-hypothesis-results.json)
contains only synthetic measurements and the inspected artifact's SHA-256.

On the inspected legacy artifact, the slow queue completed 100 sends with no
machine send and three physical live entries; its captured barrier remained
pending. Removing heartbeat replacement completed the barrier; the position
control delivered 33 machine updates. The stalled 502 body had no SDK request
timer remaining, while finite-body, 204 and body-deadline controls settled.
Syntax and invalid-input checks passed. Root validation was blocked by missing
Corepack/dependencies; docs and public-boundary checks reported pre-existing
broken links and unresolved ACP workspaces. No gated commit or production fix
is claimed.
