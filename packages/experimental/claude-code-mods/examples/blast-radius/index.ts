import { defineMod } from '../../src/define-mod.ts'
import { register } from './hooks/blast-radius.mjs'

/** Blast Radius as a DSH plugin: holds a risky Bash command until a Proceed or Cancel press. */
export default defineMod({
  name: 'blast-radius',
  version: '0.1.0',
  root: import.meta.dirname,
  register,
})
