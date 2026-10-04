import { defineMod } from '../../src/define-mod.ts'
import { register } from './guard-mod.mjs'

/** Refuses risky Bash commands and fails closed when the guard itself breaks. */
export default defineMod({ name: 'guard-mod', version: '0.1.0', register })
