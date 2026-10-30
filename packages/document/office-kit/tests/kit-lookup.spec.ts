/** Kit lookups from a consumer select its module entry and CLI, or report that the consumer has no Kit. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { resolveKitCli, resolveKitModule } from '../src/locate.ts'

afterEach(() => { vi.unstubAllGlobals() })

function kitTree(options: { cli?: boolean; layout?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-kit-lookup-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const kitRoot = join(root, options.layout ?? '', 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const entry = join(kitRoot, 'lib', 'index.js')
  const cli = join(kitRoot, 'lib', 'cli.js')
  const engine = join(kitRoot, 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm', 'package.json')
  mkdirSync(dirname(engine), { recursive: true })
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(join(kitRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/libreoffice-kit', exports: { '.': './lib/index.js', './cli': './lib/cli.js' },
  }))
  writeFileSync(entry, '')
  if (options.cli !== false) writeFileSync(cli, '')
  writeFileSync(engine, JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm' }))
  const node = join(root, 'node')
  writeFileSync(node, '')
  return { root, entryUrl: pathToFileURL(entry), cli, engine, node }
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

it('disables the CLI without inspecting paths or looking up Kit', () => {
  const lookupKitEntry = vi.fn(missingKit)
  expect(resolveKitCli({ cli: false, node: 'relative', lookupKitEntry })).toEqual({ kind: 'disabled' })
  expect(lookupKitEntry).not.toHaveBeenCalled()
})

it('uses the current executable and the consumer Kit CLI export by default', () => {
  const fixture = kitTree()
  expect(resolveKitCli({ lookupKitEntry: () => fixture.entryUrl }))
    .toEqual({ kind: 'available', node: process.execPath, cli: fixture.cli })
})

it('uses configured paths without looking up Kit', () => {
  const fixture = kitTree()
  const lookupKitEntry = vi.fn(missingKit)
  expect(resolveKitCli({ node: fixture.node, cli: fixture.cli, lookupKitEntry }))
    .toEqual({ kind: 'available', node: fixture.node, cli: fixture.cli })
  expect(lookupKitEntry).not.toHaveBeenCalled()
})

it('reports a missing Kit when the CLI is omitted and the lookup fails', () => {
  expect(resolveKitCli({ lookupKitEntry: missingKit })).toEqual({ kind: 'missing', error: absent })
})

it('requires an explicit Node executable in Electron', () => {
  const fixture = kitTree()
  vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '41.0.0' } })
  expect(() => resolveKitCli({ lookupKitEntry: () => fixture.entryUrl })).toThrow('packaged applications must supply a standalone Node executable')
  expect(resolveKitCli({ node: fixture.node, lookupKitEntry: () => fixture.entryUrl }))
    .toEqual({ kind: 'available', node: fixture.node, cli: fixture.cli })
})

it.each([
  ['a relative Node path', (root: string) => ({ node: 'node', cli: join(root, 'node') })],
  ['an absent Node file', (root: string) => ({ node: join(root, 'absent'), cli: join(root, 'node') })],
  ['a Node directory', (root: string) => ({ node: root, cli: join(root, 'node') })],
  ['a relative CLI path', (root: string) => ({ node: join(root, 'node'), cli: 'cli.js' })],
  ['an absent CLI file', (root: string) => ({ node: join(root, 'node'), cli: join(root, 'absent.js') })],
])('rejects %s', (_label, paths) => {
  const fixture = kitTree()
  expect(() => resolveKitCli({ ...paths(fixture.root), lookupKitEntry: missingKit })).toThrow('expected an absolute executable file')
})

it('propagates the Node error for a found Kit whose CLI export target is absent', () => {
  const fixture = kitTree({ cli: false })
  expect(() => resolveKitCli({ lookupKitEntry: () => fixture.entryUrl })).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})


it('restricts automatic Kit discovery to the configured root', () => {
  const fixture = kitTree()
  expect(resolveKitCli({ root: fixture.root, lookupKitEntry: () => fixture.entryUrl }))
    .toEqual({ kind: 'available', node: process.execPath, cli: fixture.cli })
  const restricted = join(fixture.root, 'restricted')
  mkdirSync(restricted)
  expect(resolveKitCli({ root: restricted, lookupKitEntry: () => fixture.entryUrl }))
    .toHaveProperty('error.message', expect.stringContaining('outside root'))
  expect(resolveKitCli({ lookupKitEntry: () => fixture.entryUrl }).kind).toBe('available')
})

it('rejects relative roots, including with explicitly disabled CLI access', () => {
  expect(() => resolveKitCli({ root: 'runtime', cli: false, lookupKitEntry: missingKit })).toThrow('root must be an absolute directory')
})

it('reports an unavailable root rather than exposing an unrelated Kit', () => {
  const fixture = kitTree()
  expect(resolveKitCli({ root: join(fixture.root, 'absent'), lookupKitEntry: () => fixture.entryUrl }))
    .toMatchObject({ kind: 'missing', error: { code: 'ENOENT' } })
})

it('allows an explicit CLI outside the automatic discovery root', () => {
  const fixture = kitTree()
  expect(resolveKitCli({ root: join(fixture.root, 'absent'), cli: fixture.cli, lookupKitEntry: missingKit }))
    .toEqual({ kind: 'available', node: process.execPath, cli: fixture.cli })
})

it('canonicalizes root aliases and rejects an entry alias outside the root', () => {
  const fixture = kitTree()
  const alias = join(fixture.root, 'runtime-alias')
  symlinkSync(dirname(dirname(fixture.cli)), alias, 'junction')
  expect(resolveKitCli({ root: alias, lookupKitEntry: () => fixture.entryUrl }).kind).toBe('available')
  const restricted = join(fixture.root, 'restricted')
  mkdirSync(restricted)
  const entryAlias = join(restricted, 'kit')
  symlinkSync(dirname(dirname(fixture.cli)), entryAlias, 'junction')
  expect(resolveKitCli({ root: restricted, lookupKitEntry: () => pathToFileURL(join(entryAlias, 'lib', 'index.js')) }))
    .toHaveProperty('error.message', expect.stringContaining('outside root'))
})

it('rejects a CLI export symlink outside the root even when the Kit entry is inside', () => {
  const fixture = kitTree({ cli: false })
  const external = kitTree()
  symlinkSync(external.cli, fixture.cli)
  expect(resolveKitCli({ root: fixture.root, lookupKitEntry: () => fixture.entryUrl }))
    .toHaveProperty('error.message', expect.stringContaining('outside root'))
})

it.each(['app.asar', 'app.asar/dsh'])('compares an ASAR root %s against its unpacked directory', (layout) => {
  const fixture = kitTree({ layout: layout.replace('.asar', '.asar.unpacked') })
  const root = join(fixture.root, layout)
  expect(resolveKitCli({ root, lookupKitEntry: () => fixture.entryUrl }))
    .toEqual({ kind: 'available', node: process.execPath, cli: fixture.cli })
  const external = kitTree()
  expect(resolveKitCli({ root, lookupKitEntry: () => external.entryUrl }))
    .toHaveProperty('error.message', expect.stringContaining('outside root'))
})
