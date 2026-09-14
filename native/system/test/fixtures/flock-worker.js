/** Hold work before or inside its callback while the parent terminates this environment. */
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { tryLockExclusive } from '../../packages/entry/lib/flock.js';
import { loadFlockBinding } from './flock-binding.js';

let nativeWork = 0;
const hook = createHook({
  init(_id, type) {
    if (type === 'flock') nativeWork++;
  },
});
hook.enable();
try {
  if (workerData.phase === 'callback') {
    loadFlockBinding().tryLock(workerData.fd, () => {
      parentPort.postMessage({ type: 'callback', nativeWork });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  } else {
    const pending = tryLockExclusive(workerData.fd);
    assert.equal(nativeWork, 1);
    parentPort.postMessage({ type: 'queued', nativeWork });
    // No JS yield precedes this wait, so the native completion cannot run first.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    await pending;
  }
} finally {
  hook.disable();
}
