/** Ordinary file I/O from a process that never acquires a lock. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';

const request = once(process, 'message');
await send({ type: 'ready' });
const [command] = await request;
assert.equal(command, 'read-write');
const previous = readFileSync(process.argv[2], 'utf8');
writeFileSync(process.argv[2], 'written without acquiring a lock');
await send({ type: 'written', previous });
process.disconnect();

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
