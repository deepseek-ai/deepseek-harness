/** Isolate an uncaught native-callback exception from the test runner. */
import { loadFlockBinding } from './flock-binding.js';

const binding = loadFlockBinding();
process.send({ type: 'ready' });
binding.tryLock(-1, () => { throw new Error('flock callback failure'); });
