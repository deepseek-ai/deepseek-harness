import { defineMod } from '../../src/define-mod.ts'
import { register } from './hooks/replay-theater.mjs'

/** Replay Theater as a DSH plugin: records a turn's Edit and Write calls and steps through them from /replay. */
export default defineMod({
  name: 'replay-theater',
  version: '0.1.0',
  root: import.meta.dirname,
  register,
})
