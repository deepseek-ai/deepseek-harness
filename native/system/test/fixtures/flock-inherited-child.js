/** fd 4 is inherited through spawn's stdio mapping, never reopened by path. */
import assert from 'node:assert/strict';
import { on } from 'node:events';
import { closeSync, fstatSync } from 'node:fs';
import { tryLockExclusive } from '../../packages/entry/lib/flock.js';

const messages = on(process, 'message');
let fd = 4;
try {
  assert.ok(fstatSync(fd).isFile());
  await send({ type: 'ready' });
  for await (const [command] of messages) {
    if (command === 'quit') {
      await send({ type: 'bye' });
      break;
    }
    if (command === 'close') {
      closeSync(fd);
      fd = undefined;
      await send({ type: 'closed' });
      continue;
    }
    assert.equal(command, 'tryLock');
    await tryLockExclusive(fd);
    await send({ type: 'locked' });
  }
} finally {
  await messages.return();
  if (fd !== undefined) closeSync(fd);
  if (process.connected) process.disconnect();
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
