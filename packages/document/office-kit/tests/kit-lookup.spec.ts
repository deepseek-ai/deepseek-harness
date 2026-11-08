/** Kit lookups from a consumer select its module entry, or report that the consumer has no Kit. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { resolveKitModule } from '../src/locate.ts'

function kitTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-kit-lookup-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const kitDirectory = join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const entry = join(kitDirectory, 'lib', 'index.js')
  const engine = join(kitDirectory, 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm', 'package.json')
  mkdirSync(dirname(engine), { recursive: true })
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(join(kitDirectory, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/libreoffice-kit', exports: { '.': './lib/index.js' },
  }))
  writeFileSync(entry, '')
  writeFileSync(engine, JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm' }))
  return { entryUrl: pathToFileURL(entry), engine }
}

const absent = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
const missingKit = (): never => { throw absent }

it.each(['URL object', 'file URL string'])('locates the module entry and engines of the consumer Kit from a %s', (input) => {
  const fixture = kitTree()
  const resolution = resolveKitModule(() => input === 'URL object' ? fixture.entryUrl : fixture.entryUrl.href)
  if (resolution.kind !== 'available') throw new Error('Expected an available Kit')
  expect(resolution.entry).toBe(fixture.entryUrl.href)
  expect(resolution.resolveEnginePackage('@deepseek-ai/libreoffice-kit-wasm')).toBe(fixture.engine)
})

it('reports a missing Kit module with the lookup failure', () => {
  expect(resolveKitModule(missingKit)).toEqual({ kind: 'missing', error: absent })
})
