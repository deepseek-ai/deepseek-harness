/** IPC-controlled lock holder; acknowledgements follow settled syscalls or close. */
import assert from 'node:assert/strict';
import { once, on } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { tryLockExclusive } from '../../packages/entry/lib/flock.js';

const messages = on(process, 'message');
let fd = openSync(process.argv[2], 'a+', 0o600);
try {
  await send({ type: 'ready' });
  for await (const [command] of messages) {
    if (command === 'close') {
      closeSync(fd);
      fd = undefined;
      await send({ type: 'closed' });
      break;
    }
    assert.equal(command, 'tryLock');
    let reply;
    try {
      await tryLockExclusive(fd);
      reply = { type: 'locked' };
    } catch (error) {
      reply = { type: 'error', code: error.code, errno: error.errno, syscall: error.syscall };
    }
    await send(reply);
  }
} finally {
  await messages.return();
  if (fd !== undefined) closeSync(fd);
  if (process.connected) {
    const disconnected = once(process, 'disconnect');
    process.disconnect();
    await disconnected;
  }
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
