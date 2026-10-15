# Deterministic history-work scaling probe

Status: implemented
Translation: current
PR: [#1](https://github.com/leynos/Lody/pull/1)

[中文](2026-10-15-history-work-harness.zh.md)

## Abstract

The daemon can spend seconds processing session history on its main thread.
This diagnostic isolates two mechanisms in the current source: repeated linear
child-run lookup and sub-agent batches falling back to the whole-history writer.
It executes real source fragments with synthetic data and counts operations,
avoiding host-dependent performance thresholds. The results demonstrate scaling
and routing, not elapsed stalls or the cause of a production presence outage.

## Run and provenance

```sh
node scripts/probe-history-work.mjs
```

Use Node 22.14+ with `stripTypeScriptTypes` support, or the repository's newer
supported Node runtime. No dependency installation is needed. The probe reads
three source files from this checkout and reports their SHA-256 hashes. It erases
TypeScript syntax and declaration exports, but does not rewrite function bodies.
Extraction fails explicitly for unsupported layouts. Only run trusted source;
the VM is not a security boundary. No application is imported or started.

The recorded source base is `a06a69f3e96eec68751ebd4df1d050cbbc4f1cea`.
`scripts/history-work-results.json` retains the synthetic measurements.

## Hypothesis and execution packet

Prediction: increasing history from 16 to 256 turns increases last-item lookup
work sixteenfold; repeating 32 child events multiplies the search work by 32.
Thirty-two child batches request whole-history exports, whereas the ordinary
text control stays on the targeted writer. Constant scan work or targeted child
routing would falsify these claims. The parent authored the experiment; an
independent `alchemist` executed it with no edits or live service access.

The measured item-inspection counts were 128, 2,048, and 65,536. Thirty-two child
batches requested 512 exported turns for the small fixture and 8,192 for the
large one. The text control requested zero full exports and 32 targeted writes.
A pre-built lookup control retrieves the same result without another scan;
it illustrates sensitivity, not a proposed production implementation.

## Responsibility and limits

The routing experiment executes `createSessionAgentWrites`, with mutation
replaced by a no-op and an instrumented writer boundary. The lookup experiment
executes `findRun` separately. The actual `readStored` method calls an injected
`toJSON` boundary; this does not execute WASM, SQLite or Immer. These are separate
boundary experiments, not an end-to-end ACP replay or a latency benchmark.

This confirms residual whole-history work despite the targeted-update fast path.
It does not prove a deadlock, an unbounded thread count, or any particular
network failure. A subsequent production fix needs behavioural coverage and
profiling at its real storage boundary; this branch changes no product code.

Real transcripts and daemon logs are deliberately excluded. The presence queue
probe concerns an older transport and is not evidence that the current native
Effect presence implementation has the same defect. The separate file-lock
harness documents lock boundaries without combining its verdict with this one.
