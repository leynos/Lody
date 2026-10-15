#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Trusted checkout only. VM evaluation is not a security boundary. These exact
// source fragments execute against synthetic readers/writers, never live data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = new Map();
function read(relative) {
  const text = readFileSync(path.join(root, relative), 'utf8');
  sources.set(relative, createHash('sha256').update(text).digest('hex'));
  return text;
}
function between(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Unsupported source layout: ${start}`);
  return text.slice(first, last);
}
function evaluate(text, expression, capabilities = {}) {
  // Only declaration exports are removed for script evaluation; function bodies
  // are unchanged apart from Node's TypeScript erasure.
  const javascript = stripTypeScriptTypes(text.replace(/^export /gm, ''), { mode: 'transform' });
  return vm.runInNewContext(`${javascript}\n${expression}`, capabilities);
}

const applier = read('packages/shared/src/acp/history-apply.ts');
const writerSource = read('packages/shared/src/history-writer.ts');
const writesSource = read('apps/cli/src/lib/loro/session-agent-writes.ts');
const findRun = evaluate(
  `class Probe { ${between(applier, '  private findRun(', '\n  /** Run identity')} }`,
  'Probe.prototype.findRun'
);
const targetLocalToolCallIds = evaluate(
  between(
    applier,
    'export const targetLocalToolCallIds =',
    '\nexport const buildMessageContentFromNotification'
  ),
  'targetLocalToolCallIds',
  {
    // Fixtures contain no Devin metadata and no tool-call notifications. These
    // guards fail closed if a future route starts relying on either capability.
    getDevinSubagentContextId: (meta) => {
      assert.equal(meta, undefined);
      return null;
    },
    toolUpdateSubagentTasks: () => {
      throw new Error('Unexpected tool-call fixture');
    },
  }
);
const readStoredDeclaration = between(writerSource, '    readStored() {', '\n    capture() {');
const writesDeclaration = writesSource.slice(
  writesSource.indexOf('export function createSessionAgentWrites(')
);
assert.ok(writesDeclaration.startsWith('export function createSessionAgentWrites('));

function fixture(turns, itemsPerTurn) {
  let inspectedItems = 0;
  const history = Array.from({ length: turns }, (_entry, turn) => ({
    id: `turn-${turn}`,
    items: Array.from({ length: itemsPerTurn }, (_slot, item) => ({
      get type() {
        inspectedItems += 1;
        return 'subagent_task';
      },
      taskId: turn === turns - 1 && item === itemsPerTurn - 1 ? 'wanted' : `other-${turn}-${item}`,
      run: { sessionId: 'synthetic-root' },
    })),
  }));
  return { history, inspected: () => inspectedItems };
}

function scanExperiment(turns, events) {
  const data = fixture(turns, 8);
  const owner = { history: data.history, readEntryItems: (i) => data.history[i].items };
  let result;
  for (let i = 0; i < events; i += 1) result = findRun.call(owner, 'synthetic-root', 'wanted');
  assert.equal(result.entryIndex, turns - 1);
  assert.equal(result.itemIndex, 7);
  assert.equal(data.inspected(), turns * 8 * events);
  // Sensitivity control only: a pre-built lookup returns the identical stored
  // task without rescanning. This is not an implementation of a proposed fix.
  const indexed = new Map([['wanted', result]]);
  for (let i = 0; i < events; i += 1) assert.equal(indexed.get('wanted'), result);
  assert.equal(data.inspected(), turns * 8 * events);
  return {
    turns,
    itemsPerTurn: 8,
    events,
    inspectedItems: data.inspected(),
    indexedLookups: events,
  };
}

async function routeExperiment(sessionUpdate, turns, batches) {
  let wholeReads = 0;
  let exportedTurns = 0;
  let targetedWrites = 0;
  let wholeWrites = 0;
  const history = Array.from({ length: turns }, (_, i) => ({ id: `turn-${i}`, items: [] }));
  // Execute the actual readStored method. toJSON is an instrumented boundary,
  // not the WASM implementation: count data requested, not elapsed CPU time.
  const stored = evaluate(`const reader = { ${readStoredDeclaration} };`, 'reader', {
    list: {
      toJSON: () => {
        wholeReads += 1;
        exportedTurns += turns;
        return history;
      },
    },
  });
  const writer = {
    updateTail: (_target, _toolIds, apply) => {
      targetedWrites += 1;
      apply([history.at(-1)]);
      return true;
    },
    updateEntry: () => {
      throw new Error('Unexpected entry-bound route');
    },
    update: (apply) => {
      wholeWrites += 1;
      apply(stored.readStored());
    },
  };
  const writes = evaluate(writesDeclaration, 'createSessionAgentWrites(writer)', {
    writer,
    targetLocalToolCallIds,
    // Routing is the boundary under test; mutation is deliberately a no-op.
    applyNotificationOnHistory: (entries) => entries,
    applyMessageContentsBatch: () => {
      throw new Error('Unexpected rich content');
    },
  });
  for (let i = 0; i < batches; i += 1) {
    await writes.applyAgentBatch({
      targetAssistantEntryId: `turn-${turns - 1}`,
      notifications: [{ update: { sessionUpdate } }],
    });
  }
  if (sessionUpdate === 'subagent_event') {
    assert.equal(wholeWrites, batches);
    assert.equal(wholeReads, batches);
    assert.equal(exportedTurns, turns * batches);
    assert.equal(targetedWrites, 0);
  } else {
    assert.equal(wholeReads, 0);
    assert.equal(targetedWrites, batches);
  }
  return { sessionUpdate, turns, batches, wholeWrites, wholeReads, exportedTurns, targetedWrites };
}

const scans = [scanExperiment(16, 1), scanExperiment(256, 1), scanExperiment(256, 32)];
const routes = [
  await routeExperiment('subagent_event', 16, 32),
  await routeExperiment('subagent_event', 256, 32),
  await routeExperiment('agent_message_chunk', 256, 32),
];
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      experiment: 'history-work-scaling',
      sourceHashes: Object.fromEntries(sources),
      scans,
      routes,
      verdict: 'reproduced: whole-history fallback and repeated linear child lookup',
      limits: [
        'Operation counts only; no WASM, Immer, SQLite or wall-clock performance measurement.',
        'Routing and lookup are separate boundary experiments, not an end-to-end ACP replay.',
        'No proof of a production timeout, deadlock or presence outage.',
      ],
    },
    null,
    2
  )
);
