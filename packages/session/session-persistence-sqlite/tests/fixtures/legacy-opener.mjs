/** Built-package import holder with stdin barriers for ownership handoff. @module */
import { Context } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline'
import * as persistence from '@deepseek-ai/dsh-session-persistence-sqlite'

const [root, id, access, pause] = process.argv.slice(2)
const ctx = new Context()
const lines = createInterface({ input: process.stdin })
const commands = lines[Symbol.asyncIterator]()
try {
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
    await using handle = await ctx.sessionPersistence.open(id, access)
    process.stdout.write('opened\n')
    await commands.next()
  } catch (error) {
    process.stdout.write(`${error.name}\n`)
    // The suite asserts on the name; the message and cause go to the inherited stderr for diagnosis.
    process.stderr.write(`legacy opener ${access} ${id}: ${String(error)}${error.cause === undefined ? '' : ` (cause: ${String(error.cause)})`}\n`)
  }
} finally {
  await ctx.fiber.dispose()
  lines.close()
  process.stdin.destroy()
}
