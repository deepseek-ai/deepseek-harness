/** Kernel behavior through the built flock entry; each case owns its files and processes. */
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { tryLockExclusive } from '../packages/entry/lib/flock.js';
import { loadFlockBinding } from './fixtures/flock-binding.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';
const timeout = 120_000;
const nativeOnly = { timeout, skip: posix ? false : 'The flock addon requires Linux or macOS' };

function resources(t) {
  const disposers = [];
  // Match the repository's process-e2e budget for both cases and cleanup.
  t.after(async () => {
    // Cleanup must await close even when the case's signal is already aborted.
    const signal = AbortSignal.timeout(timeout);
    const errors = [];
    for (const dispose of disposers.reverse()) {
      try {
        await dispose(signal);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'flock test cleanup failed');
  }, { timeout });
  // On local Linux filesystems, flock and OFD byte-range locks are independent;
  // network filesystems can translate between them and hide a wrong syscall.
  const root = mkdtempSync(join(tmpdir(), 'node-addon-system-flock-'));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    file: join(root, 'lock'),
    defer: (dispose) => disposers.push(dispose),
    open(name = 'lock') {
      const fd = openSync(join(root, name), 'a+', 0o600);
      let closed = false;
      const close = () => {
        if (!closed) {
          closeSync(fd);
          closed = true;
        }
      };
      disposers.push(close);
      return { fd, close };
    },
  };
}

function flockError(error, codes) {
  assert.ok(codes.includes(error.code), `Unexpected flock error: ${error.code}`);
  assert.equal(error.errno, constants.errno[error.code]);
  assert.ok(error.errno > 0);
  assert.equal(error.syscall, 'flock');
  return true;
}

const busy = (error) => flockError(error, ['EAGAIN', 'EWOULDBLOCK']);

async function until(promise, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name)));
}

function observeChild(t, scope, child) {
  let closed = false;
  let stderr = '';
  let processError;
  const done = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal, stderr, error: processError });
  }));
  scope.defer(async (signal) => {
    if (!closed) child.kill('SIGKILL');
    await until(done, signal);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { processError = error; });

  async function response(emitter, event, send = () => Promise.resolve()) {
    const waiting = new AbortController();
    const signal = AbortSignal.any([t.signal, waiting.signal]);
    try {
      const received = Promise.race([
        once(emitter, event, { signal }).then(([message]) => message),
        done.then((result) => {
          throw new Error(`flock fixture exited before replying: ${JSON.stringify(result)}`);
        }),
      ]);
      const [message] = await until(Promise.all([received, send()]), signal);
      return message;
    } finally {
      waiting.abort();
    }
  }

  return { child, response, waitForExit: () => until(done, t.signal) };
}

async function childFixture(t, scope, fixture, args = [], { execArgv = [], inheritedFd } = {}) {
  const stdio = ['ignore', 'ignore', 'pipe', 'ipc'];
  if (inheritedFd !== undefined) stdio.push(inheritedFd);
  const child = fork(new URL(`./fixtures/${fixture}`, import.meta.url), args, {
    execArgv,
    env: childEnvironment(),
    stdio,
  });
  const observed = observeChild(t, scope, child);
  const exchange = (command) => observed.response(child, 'message', () => (
    command === undefined ? Promise.resolve() : new Promise((resolve, reject) => {
      child.send(command, (error) => error ? reject(error) : resolve());
    })
  ));
  assert.deepEqual(await exchange(), { type: 'ready' });
  return { child, waitForExit: observed.waitForExit, exchange };
}

async function oracleFixture(t, scope, mode) {
  const binary = process.platform === 'linux'
    ? `./bin/${process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'}/flock-oracle`
    : './bin/flock-oracle';
  const child = spawn(fileURLToPath(new URL(binary, import.meta.url)), [scope.file, mode], {
    env: childEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const observed = observeChild(t, scope, child);
  const lines = createInterface({ input: child.stdout });
  child.once('close', () => lines.close());
  let inputError;
  child.stdin.on('error', (error) => { inputError = error; });
  const send = (command) => until(new Promise((resolve, reject) => {
    if (inputError) reject(inputError);
    else child.stdin.write(`${command}\n`, (error) => error ? reject(error) : resolve());
  }), t.signal);
  const exchange = async (command) => JSON.parse(await observed.response(lines, 'line', () => (
    command === undefined ? Promise.resolve() : send(command)
  )));
  assert.deepEqual(await exchange(), { ready: true });
  return {
    exchange,
    async quit() {
      await send('q');
      cleanExit(await observed.waitForExit());
    },
  };
}

function cleanExit(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0, result.stderr);
}

test('import succeeds with native addons disabled', { timeout }, async (t) => {
  const scope = resources(t);
  const child = await childFixture(t, scope, 'flock-import.js', [], { execArgv: ['--no-addons'] });
  cleanExit(await child.waitForExit());
});

for (const platform of ['win32', 'freebsd']) {
  test(`calling flock on ${platform} rejects without loading an addon`, { timeout }, async (t) => {
    const scope = resources(t);
    const child = await childFixture(t, scope, 'flock-import.js', [platform], { execArgv: ['--no-addons'] });
    cleanExit(await child.waitForExit());
  });
}

test('acquisition resolves asynchronously to void and the same fd can reacquire', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const result = tryLockExclusive(owner.fd);
  assert.ok(result instanceof Promise);
  assert.equal(await result, undefined);
  assert.equal(await tryLockExclusive(owner.fd), undefined);
});

test('separate opens of one file contend', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  await assert.rejects(tryLockExclusive(contender.fd), busy);
});

test('different files can be locked concurrently', nativeOnly, async (t) => {
  const scope = resources(t);
  const first = scope.open('first');
  const second = scope.open('second');
  await Promise.all([tryLockExclusive(first.fd), tryLockExclusive(second.fd)]);
});

test('closing the locked fd allows an already-open contender to acquire', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  await assert.rejects(tryLockExclusive(contender.fd), busy);
  owner.close();
  await tryLockExclusive(contender.fd);
});

test('closing another fd for the same file does not release the lock', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const other = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  other.close();
  await assert.rejects(tryLockExclusive(contender.fd), busy);
  owner.close();
  await tryLockExclusive(contender.fd);
});

test('invalid fd rejects asynchronously with EBADF and positive errno', nativeOnly, async () => {
  let result;
  assert.doesNotThrow(() => { result = tryLockExclusive(-1); });
  assert.ok(result instanceof Promise);
  await assert.rejects(result, (error) => flockError(error, ['EBADF']));
});

test('native argument errors reject the JavaScript promise without throwing from the entry', nativeOnly, async () => {
  let result;
  assert.doesNotThrow(() => { result = tryLockExclusive(2 ** 31); });
  assert.ok(result instanceof Promise);
  await assert.rejects(result, { name: 'RangeError', message: 'fd must be a signed C int' });
});

test('native callbacks receive asynchronous, request-local success and errno results', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  const binding = loadFlockBinding();
  const results = await Promise.all([owner.fd, contender.fd, -1].map((fd) => new Promise((resolve) => {
    let returned = false;
    const result = binding.tryLock(fd, (errno) => {
      assert.equal(returned, true);
      resolve(errno);
    });
    assert.equal(result, undefined);
    returned = true;
  })));
  assert.equal(results[0], 0);
  assert.ok([constants.errno.EAGAIN, constants.errno.EWOULDBLOCK].includes(results[1]));
  assert.equal(results[2], constants.errno.EBADF);
});

test('an exception in the native completion callback is reported as uncaught', nativeOnly, async (t) => {
  const scope = resources(t);
  const child = await childFixture(t, scope, 'flock-callback-throws.js');
  const exit = await child.waitForExit();
  assert.equal(exit.signal, null, exit.stderr);
  assert.equal(exit.error, undefined);
  assert.equal(exit.code, 1, exit.stderr);
  assert.match(exit.stderr, /Error: flock callback failure/);
});

test('concurrent calls retain their own syscall errno', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  await Promise.all([
    assert.rejects(tryLockExclusive(contender.fd), busy),
    assert.rejects(tryLockExclusive(-1), (error) => flockError(error, ['EBADF'])),
    assert.rejects(tryLockExclusive(contender.fd), busy),
    assert.rejects(tryLockExclusive(-1), (error) => flockError(error, ['EBADF'])),
  ]);
});

test('two child processes exclude each other and normal close transfers ownership', nativeOnly, async (t) => {
  const scope = resources(t);
  const observer = scope.open();
  const children = await Promise.all([
    childFixture(t, scope, 'flock-child.js', [scope.file]),
    childFixture(t, scope, 'flock-child.js', [scope.file]),
  ]);
  const results = await Promise.all(children.map((child) => child.exchange('tryLock')));
  assert.equal(results.filter((result) => result.type === 'locked').length, 1);
  assert.equal(results.filter((result) => result.type === 'error').length, 1);
  const winnerIndex = results.findIndex((result) => result.type === 'locked');
  const winner = children[winnerIndex];
  const loser = children[1 - winnerIndex];
  busy(results[1 - winnerIndex]);
  await assert.rejects(tryLockExclusive(observer.fd), busy);

  assert.deepEqual(await winner.exchange('close'), { type: 'closed' });
  cleanExit(await winner.waitForExit());
  assert.deepEqual(await loser.exchange('tryLock'), { type: 'locked' });
  await assert.rejects(tryLockExclusive(observer.fd), busy);
  assert.deepEqual(await loser.exchange('close'), { type: 'closed' });
  cleanExit(await loser.waitForExit());
  await tryLockExclusive(observer.fd);
});

test('SIGKILL releases a child lock after exit', nativeOnly, async (t) => {
  const scope = resources(t);
  const observer = scope.open();
  const owner = await childFixture(t, scope, 'flock-child.js', [scope.file]);
  const contender = await childFixture(t, scope, 'flock-child.js', [scope.file]);
  assert.deepEqual(await owner.exchange('tryLock'), { type: 'locked' });
  const rejected = await contender.exchange('tryLock');
  assert.equal(rejected.type, 'error');
  busy(rejected);
  assert.equal(owner.child.kill('SIGKILL'), true);
  const exit = await owner.waitForExit();
  assert.equal(exit.error, undefined);
  assert.equal(exit.signal, 'SIGKILL');
  assert.equal(exit.code, null);
  assert.deepEqual(await contender.exchange('tryLock'), { type: 'locked' });
  await assert.rejects(tryLockExclusive(observer.fd), busy);
});

for (const phase of ['queued', 'callback']) {
  test(`worker termination during ${phase} drains native work without taking ownership of the fd`, nativeOnly, async (t) => {
    const scope = resources(t);
    const owner = scope.open();
    const contender = scope.open();
    const worker = new Worker(new URL('./fixtures/flock-worker.js', import.meta.url), {
      workerData: { fd: owner.fd, phase },
      execArgv: [],
    });
    scope.defer((signal) => until(worker.terminate(), signal));
    const exited = once(worker, 'exit');
    const waiting = new AbortController();
    try {
      const [message] = await Promise.race([
        once(worker, 'message', { signal: AbortSignal.any([t.signal, waiting.signal]) }),
        exited.then(([code]) => { throw new Error(`flock worker exited before ${phase}: ${code}`); }),
      ]);
      assert.deepEqual(message, { type: phase, nativeWork: 1 });
    } finally {
      waiting.abort();
    }
    assert.equal(await until(worker.terminate(), t.signal), 1);
    await until(exited, t.signal);
    await tryLockExclusive(owner.fd);
    await assert.rejects(tryLockExclusive(contender.fd), busy);
    owner.close();
    await tryLockExclusive(contender.fd);
  });
}

for (const mode of ['exclusive', 'shared']) {
  test(`an addon exclusive lock blocks an independent C ${mode} flock until its fd closes`, nativeOnly, async (t) => {
    const scope = resources(t);
    const owner = scope.open();
    await tryLockExclusive(owner.fd);
    const oracle = await oracleFixture(t, scope, mode);
    const result = await oracle.exchange('t');
    assert.ok([constants.errno.EAGAIN, constants.errno.EWOULDBLOCK].includes(result.errno));
    owner.close();
    assert.deepEqual(await oracle.exchange('t'), { errno: 0 });
    await oracle.quit();
  });

  test(`an independent C ${mode} flock blocks the addon until explicit unlock`, nativeOnly, async (t) => {
    const scope = resources(t);
    const contender = scope.open();
    const oracle = await oracleFixture(t, scope, mode);
    assert.deepEqual(await oracle.exchange('t'), { errno: 0 });
    await assert.rejects(tryLockExclusive(contender.fd), busy);
    assert.deepEqual(await oracle.exchange('u'), { errno: 0 });
    await tryLockExclusive(contender.fd);
    await oracle.quit();
  });
}

test('an advisory exclusive lock permits another process to read and write without locking', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  writeFileSync(scope.file, 'written before locking');
  await tryLockExclusive(owner.fd);
  await assert.rejects(tryLockExclusive(contender.fd), busy);
  const child = await childFixture(t, scope, 'flock-io-child.js', [scope.file]);
  assert.deepEqual(await child.exchange('read-write'), {
    type: 'written', previous: 'written before locking',
  });
  cleanExit(await child.waitForExit());
  assert.equal(readFileSync(scope.file, 'utf8'), 'written without acquiring a lock');
  await assert.rejects(tryLockExclusive(contender.fd), busy);
});

test('an inherited fd shares the lock after parent close until the child closes its last reference', nativeOnly, async (t) => {
  const scope = resources(t);
  const owner = scope.open();
  const contender = scope.open();
  await tryLockExclusive(owner.fd);
  const child = await childFixture(t, scope, 'flock-inherited-child.js', [], { inheritedFd: owner.fd });
  assert.deepEqual(await child.exchange('tryLock'), { type: 'locked' });
  owner.close();
  await assert.rejects(tryLockExclusive(contender.fd), busy);
  assert.deepEqual(await child.exchange('close'), { type: 'closed' });
  await tryLockExclusive(contender.fd);
  // The child stays alive, so its close acknowledgement—not process exit—releases the lock.
  assert.equal(child.child.exitCode, null);
  assert.equal(child.child.signalCode, null);
  assert.deepEqual(await child.exchange('quit'), { type: 'bye' });
  cleanExit(await child.waitForExit());
});
