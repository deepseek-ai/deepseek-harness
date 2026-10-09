import { defineMod } from '../../src/define-mod.ts'
import { register } from './hooks/blast-radius.mjs'

/** Blast Radius as a DSH plugin, using the running Node executable for its cancellable hold timer. */
export default defineMod({
  name: 'blast-radius',
  version: '0.1.0',
  root: import.meta.dirname,
  register(on, options) {
    register(on, { ...options, waitArgv: [process.execPath, '-e', 'setTimeout(() => {}, 250)'] })
  },
})
