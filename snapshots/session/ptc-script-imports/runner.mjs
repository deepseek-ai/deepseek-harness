/** Custom protocol runner exercised through the headless profile's PTC provider. */
import { openInheritedControlChannel } from '../../../packages/subprocess/subprocess/src/control.ts'
import { runNodeMain } from '../../../packages/ptc-runtime/ptc-runtime-node/src/process.ts'

class Counter {
  #count = 0
  next() { return ++this.#count }
}
const exports = { Counter, counter: new Counter() }

await runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process, 'script', async ({ specifier }) => {
  if (specifier === 'runner:denied') throw new Error('Dependency import denied by runner')
  return specifier === 'runner:counter' ? { type: 'module', exports } : { type: 'default' }
})
