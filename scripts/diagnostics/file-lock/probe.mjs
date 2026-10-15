#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as runtime from 'effect';
import { TestClock } from 'effect/testing';

const { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option } = runtime;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const relative = 'packages/shared/src/node/file-lock.ts';
const source = readFileSync(path.join(root, relative), 'utf8');
const effectPackage = JSON.parse(
  readFileSync(new URL('node_modules/effect/package.json', import.meta.url))
);
assert.equal(effectPackage.version, '4.0.2', 'Use the checkout-pinned Effect runtime');

// Execute the entire current lock implementation, not a reconstructed queue.
// Only filesystem/process/installation capabilities are replaced. No real files,
// PIDs, timers or network are touched by the experiments. VM is not a sandbox
// for an untrusted checkout; only run this against source you trust.
const NodeProcess = Context.Service()('diagnostic/NodeProcess');
const processModule = {
  NodeProcess,
  nodeProcessLive: {},
  probePid: () => Effect.succeed('ours'),
  squashProcessFailure: (cause) => Option.getOrUndefined(Cause.findErrorOption(cause)),
};
const module = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {
  identifier: relative,
});
await module.link(async (specifier) => {
  let exports;
  if (specifier === 'effect') exports = runtime;
  else if (specifier.startsWith('node:')) exports = await import(specifier);
  else if (specifier === '@effect/platform-node-shared')
    exports = { NodeFileSystem: { layer: Layer.empty } };
  else if (specifier === './process') exports = processModule;
  else if (specifier === './installation-profile') exports = { getLodyDataDir: () => '/synthetic' };
  else throw new Error(`Unexpected runtime dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
});
await module.evaluate();
const { FileLocksLive, FileLockHost, withFileLock, FILE_LOCK_CLEANUP_MS } = module.namespace;

function filesystem() {
  const files = new Map();
  let sequence = 0;
  let removeHook = () => Effect.void;
  const missing = () => Effect.fail({ reason: { _tag: 'NotFound' } });
  const fs = {
    readFileString: (name) =>
      Effect.suspend(() => (files.has(name) ? Effect.succeed(files.get(name)) : missing())),
    writeFileString: (name, value) =>
      Effect.sync(() => {
        files.set(name, value);
      }),
    makeDirectory: () => Effect.void,
    makeTempDirectory: ({ directory, prefix }) =>
      Effect.sync(() => `${directory}/${prefix}${++sequence}`),
    link: (from, to) =>
      Effect.suspend(() => {
        if (files.has(to)) return Effect.fail({ reason: { _tag: 'AlreadyExists' } });
        if (!files.has(from)) return missing();
        files.set(to, files.get(from));
        return Effect.void;
      }),
    remove: (name, options) =>
      Effect.suspend(() => removeHook(name)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            files.delete(name);
            if (options?.recursive)
              for (const key of files.keys()) if (key.startsWith(`${name}/`)) files.delete(key);
          })
        )
      ),
    readDirectory: () => Effect.sync(() => [...files.keys()].map((name) => path.basename(name))),
  };
  return {
    fs,
    files,
    onRemove: (hook) => {
      removeHook = hook;
    },
  };
}

function runExperiment(program) {
  const state = filesystem();
  const locks = FileLocksLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, state.fs),
        Layer.succeed(FileLockHost, { locksDir: '/synthetic/locks', pid: 123 }),
        Layer.succeed(NodeProcess, {})
      )
    )
  );
  return Effect.runPromise(
    Effect.scoped(program(state).pipe(Effect.provide(locks))).pipe(
      Effect.provide(TestClock.layer())
    )
  );
}

const queue = await runExperiment(({ files }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make();
    const release = yield* Deferred.make();
    const order = [];
    const holder = yield* withFileLock(
      'queue',
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            order.push('holder');
          })
        )
      )
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    // forkChild starts queued work on the controlled scheduler; TestClock.adjust
    // drains runnable fibers before advancing time. No guessed microtask sleeps.
    const waiter = yield* withFileLock(
      'queue',
      Effect.sync(() => {
        order.push('waiter');
      }),
      {
        timeout: 120_000,
      }
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust(600_000);
    assert.equal(waiter.pollUnsafe(), undefined, 'Local wait is not acquisition-time bounded');
    assert.deepEqual(order, []);
    // Control: unrelated lock proceeds while the first name is held.
    yield* withFileLock(
      'independent',
      Effect.sync(() => {
        order.push('independent');
      })
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(waiter);
    assert.deepEqual(order, ['independent', 'holder', 'waiter']);
    assert.equal(files.size, 0);
    return {
      acquisitionTimeoutMs: 120_000,
      virtualQueuedMs: 600_000,
      pendingAtDeadline: true,
      order,
      drained: true,
    };
  })
);

const cleanup = await runExperiment(({ files, onRemove }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make();
    const allowRemove = yield* Deferred.make();
    const removed = yield* Deferred.make();
    const lockPath = '/synthetic/locks/cleanup.lock';
    onRemove((name) =>
      name === lockPath
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(allowRemove)),
            Effect.andThen(Deferred.succeed(removed, undefined))
          )
        : Effect.void
    );
    const first = yield* withFileLock('cleanup', Effect.succeed('body completed')).pipe(
      Effect.forkChild
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(FILE_LOCK_CLEANUP_MS + 1);
    const exit = yield* Fiber.await(first);
    assert.ok(Exit.isFailure(exit));
    const failures = exit.cause.reasons.flatMap((reason) =>
      reason._tag === 'Fail' ? [reason.error] : []
    );
    assert.ok(failures.some((failure) => failure._tag === 'LockReleaseFailed'));
    assert.equal(files.has(lockPath), true, 'Raw release retains ownership after waiter expiry');
    // Let the ORIGINAL operation finish; do not replace/delete its ownership.
    yield* Deferred.succeed(allowRemove, undefined);
    yield* Deferred.await(removed);
    yield* withFileLock('cleanup', Effect.void);
    assert.equal(files.size, 0);
    return {
      bodyCompleted: true,
      cleanupDeadlineMs: FILE_LOCK_CLEANUP_MS,
      failure: 'LockReleaseFailed',
      ownershipRetainedAtTimeout: true,
      recovered: true,
    };
  })
);

const immediateCleanup = await runExperiment(({ files }) =>
  Effect.gen(function* () {
    const value = yield* withFileLock('control', Effect.succeed('ok'));
    assert.equal(value, 'ok');
    assert.equal(files.size, 0);
    return { result: value, remainingFiles: files.size };
  })
);

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      experiment: 'file-lock-boundaries',
      sourceHashes: { [relative]: createHash('sha256').update(source).digest('hex') },
      effectVersion: effectPackage.version,
      queue,
      cleanup,
      immediateCleanup,
      verdict:
        'reproduced: queue timeout scope and bounded cleanup failure; not a circular deadlock',
      limits: [
        'Both behaviours are already intentional and covered by upstream lock tests.',
        'A gated synthetic unlink is not proof that CPU starvation caused the production failure.',
        'No live lock, daemon, filesystem, PID, cloud transport or conversation was accessed.',
      ],
    },
    null,
    2
  )
);
