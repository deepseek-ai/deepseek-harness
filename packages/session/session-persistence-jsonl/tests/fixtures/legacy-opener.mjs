/** Built-package import holder; stdin barriers keep migration and write ownership observable. @module */
import { Context } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, id, access, pause] = process.argv.slice(2)
const ctx = new Context()
const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
if (pause === 'start') {
  process.stdout.write('ready\n')
  await commands.next()
}
await ctx.plugin(persistence, { root, compression: 'none' })
if (pause === 'pause') {
  const reader = Reflect.get(ctx.sessionPersistence, 'jsonl')
  const prepare = reader.prepare.bind(reader)
  reader.prepare = async (...args) => {
    process.stdout.write('reading\n')
    await commands.next()
    return prepare(...args)
  }
}
if (pause === 'wait') {
  const sqlite = Reflect.get(ctx.sessionPersistence, 'sqlite')
  const acquire = sqlite.acquireSessionLease.bind(sqlite)
  let reported = false
  sqlite.acquireSessionLease = async (...args) => {
    try { return await acquire(...args) }
    catch (error) {
      if (!reported && error.name === 'SessionAlreadyOwnedError') {
        reported = true
        process.stdout.write('contended\n')
      }
      throw error
    }
  }
}
try {
  const handle = await ctx.sessionPersistence.open(id, access)
  process.stdout.write('opened\n')
  await commands.next()
  await handle.close()
} catch (error) {
  process.stdout.write(`${error.name}\n`)
} finally {
  await ctx.fiber.dispose()
  process.stdin.destroy()
}
