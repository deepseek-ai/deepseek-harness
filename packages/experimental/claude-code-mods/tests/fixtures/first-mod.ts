import { defineMod } from '../../src/define-mod.ts'
import { register } from './first-mod.mjs'

/** The Claude Code tutorial's first mod, wrapped as a DSH plugin. */
export default defineMod({ name: 'first-mod', version: '0.1.0', userConfig: { greeting: 'Claude has made' }, register })
