import { defineMod } from '../../src/define-mod.ts'
import { register } from './hooks/token-weather.mjs'

/**
 * Token Weather as a DSH plugin: the blog's module and type contract run
 * unchanged; this wrapper gives it the plugin identity `plugin.json` holds.
 */
export default defineMod({
  name: 'token-weather',
  version: '0.1.0',
  root: import.meta.dirname,
  register,
})
