import { defineMod } from '../../src/define-mod.ts'
import { register } from './ticket-mod.mjs'

/** Registers a ticket lookup tool, adds branch context to PR prompts, and times turns. */
export default defineMod({ name: 'ticket-mod', version: '0.1.0', register })
