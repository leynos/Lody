#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// This diagnostic executes selected methods from a trusted, explicitly supplied
// compiled bundle. It never imports the bundle or starts a daemon. The VM is an
// isolation convenience, not a security boundary for untrusted JavaScript.
function between(source, start, end, offset = 0) {
  const first = source.indexOf(start, offset);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) {
    throw new Error(`Unsupported bundle layout: missing ${start} or ${end}`);
  }
  return source.slice(first, last);
}

class Deque {
  entries = [];
  pushBack(entry) { this.entries.push(entry); }
  popFront() { return this.entries.shift(); }
  peekFront() { return this.entries[0]; }
  get length() { return this.entries.length; }
  toArray() { return this.entries.slice(); }
  clear() { this.entries = []; }
}

function loadQueue(source) {
  const declaration = between(
    source,
    'EphemeralStreamCrdt = class {',
    '\nfunction composeBeforeRemoteCursorSaveHooks'
  );
  const context = {
    Deque,
    AbortController,
    PENDING_LOCAL_REBUILD_MIN_SUPERSEDED: 64,
    module: { exports: undefined },
  };
  vm.runInNewContext(
    `module.exports = ${declaration.slice('EphemeralStreamCrdt = '.length)}`,
    context
  );
  const queue = Object.create(context.module.exports.prototype);
  queue.adaptor = { localUpdateKey: (update) => update.key };
  // Controlled acknowledgements below replace network scheduling, not queue logic.
  queue.flushPendingLocal = () => {};
  return queue;
}

async function queueExperiment(source, { refreshMachine, preservePosition }) {
  const queue = loadQueue(source);
  if (preservePosition) {
    // Sensitivity control: replace bytes/count in place instead of moving the
    // old chain to the tail. This is an experimental ablation, not a product fix.
    const original = queue.enqueueLocal;
    queue.enqueueLocal = function (state, update) {
      const previous = state.pendingLocalByKey.get(update.key);
      if (!previous) return original.call(this, state, update);
      previous.update = update;
      previous.count += 1;
      state.pendingLocalCount += 1;
    };
  }
  const state = queue.createJoinState();
  state.writeStatus = 'ok';
  const publish = (key) => queue.enqueueLocal(state, { byteLength: 1, key });
  for (const key of ['session-a', 'session-b', 'machine']) publish(key);
  // Capture an actual SDK barrier before starting the controlled send schedule.
  const subscription = queue.createSubscription(state);
  let barrierComplete = false;
  const barrier = subscription.waitUntilSynced().then(() => { barrierComplete = true; });
  const sent = [];
  for (let step = 0; step < 100; step += 1) {
    const entry = queue.nextPendingLocal(state);
    if (!entry) break;
    sent.push(entry.key);
    state.pendingLocal.popFront();
    state.pendingLocalCount -= entry.count;
    state.liveChains -= 1;
    queue.notifyChainAcknowledged(state, entry.chainId);
    // One heartbeat interval between sends is a deliberate slow-writer schedule.
    // Time is logical: no sleeps or real timers run in this experiment.
    if (entry.key !== 'machine') publish(entry.key);
    if (refreshMachine) publish('machine');
  }
  // Follow the explicit acknowledgement receipt, not a guessed number of
  // microtask turns. A still-registered waiter is the pending observation.
  if (state.syncWaiters.length === 0) await barrier;
  return {
    sends: sent.length,
    machineSends: sent.filter((key) => key === 'machine').length,
    pendingLogical: state.pendingLocalCount,
    liveChains: state.liveChains,
    physicalLiveEntries: state.pendingLocal.toArray().filter((entry) => !entry.superseded).length,
    barrierComplete,
    // Keeping the promise reachable is intentional; unresolved is an observation.
    barrierStillPending: !barrierComplete && Boolean(barrier),
  };
}

class Clock {
  now = 0;
  sequence = 0;
  timers = new Map();
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { callback, due: this.now + delay });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  advance(milliseconds) {
    this.now += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

async function bodyExperiment(source, { status, releaseBody, retainDeadline }) {
  const offset = source.indexOf('async appendEphemeralUpdate');
  if (offset < 0) throw new Error('Unsupported bundle: ephemeral append not found');
  const fetchMethod = between(source, 'async fetchWithTimeout(', '\n  async resolveToken', offset);
  const failureMethod = between(source, 'async responseToEphemeralFailure', '\n  ephemeralReadEndpoint', offset);
  const clock = new Clock();
  const context = {
    module: { exports: undefined },
    AbortController,
    mergeAbortSignals: (_parent, owned) => owned,
    TimeoutError2: Error,
    HttpError: Error,
    extractRequestIdFromResponseHeaders: () => undefined,
    parseRetryAfterMs$1: () => undefined,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  vm.runInNewContext(`module.exports = { ${fetchMethod}, ${failureMethod} };`, context);
  const client = context.module.exports;
  let finishBody;
  const body = new Promise((resolve) => { finishBody = resolve; });
  let signal;
  client.fetchImpl = async (_url, init) => {
    signal = init.signal;
    return { status, headers: { get: () => null }, text: () => body };
  };
  const response = await client.fetchWithTimeout('https://synthetic.invalid/', {}, 10_000, 'connect');
  const timersAfterHeaders = clock.timers.size;
  let settled = false;
  let deadlineReached = false;
  const operation = (status === 200 || status === 204
    ? Promise.resolve()
    : client.responseToEphemeralFailure(response, 'ephemeral append')
  ).then(() => { settled = true; });
  let deadline;
  if (retainDeadline) {
    deadline = clock.setTimeout(() => {
      deadlineReached = true;
      // Explicit synthetic body cancellation models a deadline spanning the body.
      finishBody('cancelled by controlled body deadline');
    }, 10_000);
  }
  clock.advance(60_000);
  // Observe the actual Promise chain; a sentinel crosses both method boundaries.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  if (releaseBody) finishBody('synthetic error');
  if (releaseBody || retainDeadline || status === 204) await operation;
  const result = { status, timersAfterHeaders, requestAborted: signal.aborted, settled, deadlineReached };
  // Release every controlled promise after observing it; no unfinished test I/O.
  finishBody('cleanup');
  await operation;
  if (deadline) clock.clearTimeout(deadline);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--bundle') {
    throw new Error('Usage: node scripts/probe-presence-hypotheses.mjs --bundle TRUSTED_COMPILED_CLI_BUNDLE');
  }
  const bytes = readFileSync(args[1]);
  const source = bytes.toString('utf8');
  const starvation = await queueExperiment(source, { refreshMachine: true, preservePosition: false });
  const noRefresh = await queueExperiment(source, { refreshMachine: false, preservePosition: false });
  const fifoControl = await queueExperiment(source, { refreshMachine: true, preservePosition: true });
  const stalledBody = await bodyExperiment(source, { status: 502 });
  const finiteBody = await bodyExperiment(source, { status: 502, releaseBody: true });
  const success = await bodyExperiment(source, { status: 204 });
  const deadlineControl = await bodyExperiment(source, { status: 502, retainDeadline: true });
  assert.ok(noRefresh.machineSends > 0, 'Control without heartbeat replacement must deliver machine state');
  assert.ok(noRefresh.barrierComplete, 'Later independent writes must not retain the captured barrier');
  assert.ok(fifoControl.machineSends > 0, 'Position-preserving control must deliver machine state');
  assert.ok(fifoControl.barrierComplete, 'Position-preserving control must release the captured barrier');
  assert.ok(finiteBody.settled, 'Finite error bodies must settle');
  assert.ok(success.settled, '204 must settle without consuming a body');
  assert.ok(deadlineControl.settled && deadlineControl.deadlineReached, 'Body-deadline control must settle');
  console.log(JSON.stringify({
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    scope: 'Extracted installed legacy SDK methods; synthetic inputs; no network or real timers',
    queue: {
      verdict: starvation.machineSends === 0 && !starvation.barrierComplete ? 'reproduced' : 'falsified-for-this-schedule',
      starvation, noRefresh, fifoControl,
    },
    responseBody: {
      verdict: !stalledBody.settled && !stalledBody.requestAborted ? 'reproduced' : 'falsified-for-this-response',
      stalledBody, finiteBody, success, deadlineControl,
    },
    limits: 'Mechanism evidence only. Neither result proves the production incident; current native Effect SDK requires a separate adapter.',
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
