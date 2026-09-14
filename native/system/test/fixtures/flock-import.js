/** A separate process keeps unsupported-platform simulation away from other tests. */
import assert from 'node:assert/strict';

const platform = process.argv[2];
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  if (platform) Object.defineProperty(process, 'platform', { value: platform });
  const { tryLockExclusive } = await import('../../packages/entry/lib/flock.js');
  assert.equal(typeof tryLockExclusive, 'function');
  if (platform || (process.platform !== 'linux' && process.platform !== 'darwin')) {
    await assert.rejects(tryLockExclusive(-1), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    });
  }
} finally {
  Object.defineProperty(process, 'platform', descriptor);
}
await new Promise((resolve, reject) => {
  process.send({ type: 'ready' }, (error) => error ? reject(error) : resolve());
});
process.disconnect();
