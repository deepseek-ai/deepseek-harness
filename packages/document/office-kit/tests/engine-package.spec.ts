/** Engine resolution distinguishes missing installations from incomplete ones and preserves ASAR asset paths. */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createEnginePackageResolver } from '../src/locate.ts'

vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>()
  return { createRequire: vi.fn(actual.createRequire) }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})
const { createRequire: nodeCreateRequire } = await vi.importActual<typeof import('node:module')>('node:module')

afterEach(() => { vi.resetAllMocks() })

function engineTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-engine-package-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const kitDirectory = join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const kitSource = join(kitDirectory, 'lib', 'index.js')
  mkdirSync(dirname(kitSource), { recursive: true })
  writeFileSync(join(kitDirectory, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
  writeFileSync(kitSource, '')
  const host = nodeCreateRequire(join(root, 'caller.cjs'))
  const kitEntry = host.resolve('@deepseek-ai/libreoffice-kit')
  const kit = nodeCreateRequire(kitEntry)
  const resolve = vi.fn(kit.resolve)
  kit.resolve = Object.assign(resolve, { paths: kit.resolve.paths.bind(kit.resolve) })
  vi.mocked(createRequire).mockImplementation((from) => {
    if (from === kitEntry || from === pathToFileURL(kitEntry).href) return kit
    return nodeCreateRequire(from)
  })
  // A private name prevents globally installed packages from satisfying an absent fixture.
  const name = `@deepseek-ai/libreoffice-kit-${basename(root)}`
  const directory = join(kitDirectory, 'node_modules', name)
  return { root, name, directory, resolve, kit, kitEntry, resolveEnginePackage: createEnginePackageResolver(kitEntry) }
}

function thrownBy(action: () => void): unknown {
  try { action() } catch (error) { return error }
  throw new Error('Expected the operation to throw')
}

it.each([
  ['/App.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json',
    '/App.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'],
  ['C:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64\\package.json',
    'C:\\DSH\\resources\\app.asar.unpacked\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64\\package.json'],
  ['/App/resources/app.asar.unpacked/dsh/node_modules/x/package.json', '/App/resources/app.asar.unpacked/dsh/node_modules/x/package.json'],
  ['/workspace/node_modules/x/package.json', '/workspace/node_modules/x/package.json'],
  ['/workspace/notes.asar.txt/package.json', '/workspace/notes.asar.txt/package.json'],
  ['/app.asar/nested.asar/package.json', '/app.asar.unpacked/nested.asar/package.json'],
])('maps %s', (path, expected) => {
  const fixture = engineTree()
  fixture.resolve.mockReturnValue(path)
  expect(fixture.resolveEnginePackage(fixture.name)).toBe(expected)
})

it('uses physical native paths and preserves the WASM logical path in an archive', () => {
  const root = '/App/resources/app.asar/dsh/node_modules'
  const kitEntry = `${root}/@deepseek-ai/libreoffice-kit/lib/index.js`
  const kit = nodeCreateRequire(import.meta.url)
  kit.resolve = Object.assign((id: string) => `${root}/${id}`, { paths: kit.resolve.paths.bind(kit.resolve) })
  vi.mocked(createRequire).mockImplementation((from) => {
    if (from === kitEntry || from === pathToFileURL(kitEntry).href) return kit
    return nodeCreateRequire(from)
  })
  const resolveEnginePackage = createEnginePackageResolver(kitEntry)
  expect(resolveEnginePackage('@deepseek-ai/libreoffice-kit-darwin-arm64'))
    .toBe('/App/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json')
  expect(resolveEnginePackage('@deepseek-ai/libreoffice-kit-wasm'))
    .toBe('/App/resources/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json')
})

it.each(['missing manifest', 'dangling symlink', 'absent'] as const)(
  'distinguishes an engine package with %s on the kit resolution path', (state) => {
    const fixture = engineTree()
    if (state === 'missing manifest') mkdirSync(fixture.directory, { recursive: true })
    if (state === 'dangling symlink') {
      mkdirSync(dirname(fixture.directory), { recursive: true })
      symlinkSync(join(fixture.root, 'missing-target'), fixture.directory, 'junction')
    }
    const error = thrownBy(() => fixture.resolveEnginePackage(fixture.name))
    const nodeError: unknown = fixture.resolve.mock.results[0]?.value
    expect(nodeError).toMatchObject({ code: 'MODULE_NOT_FOUND' })
    if (state === 'absent') {
      expect(error).toBe(nodeError)
    } else {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toHaveProperty('code', 'MODULE_NOT_FOUND')
      expect(error).toHaveProperty('cause')
      if (!(error instanceof Error)) throw error
      expect(error.cause).toBe(nodeError)
      expect(error.message).toContain(fixture.name)
    }
  },
)

it('keeps a Node resolution error other than MODULE_NOT_FOUND unchanged', () => {
  const fixture = engineTree()
  mkdirSync(fixture.directory, { recursive: true })
  writeFileSync(join(fixture.directory, 'package.json'), '{invalid')
  const error = thrownBy(() => fixture.resolveEnginePackage(fixture.name))
  expect(error).toMatchObject({ code: 'ERR_INVALID_PACKAGE_CONFIG' })
  expect(error).toBe(fixture.resolve.mock.results[0]?.value)
  expect(lstatSync).not.toHaveBeenCalled()
})

it('preserves Node missing errors when the name has no package search paths', () => {
  const fixture = engineTree()
  const error = thrownBy(() => fixture.resolveEnginePackage('node:fs'))
  expect(error).toMatchObject({ code: 'MODULE_NOT_FOUND' })
  expect(error).toBe(fixture.resolve.mock.results[0]?.value)
  expect(lstatSync).not.toHaveBeenCalled()
})

it('propagates permission errors while checking the kit installation', () => {
  const fixture = engineTree()
  const denied = Object.assign(new Error('Cannot inspect engine installation'), { code: 'EACCES' })
  const paths = fixture.kit.resolve.paths(fixture.name)
  if (!paths?.[0]) throw new Error('Fixture package must have Node resolution paths')
  const firstDirectory = join(paths[0], fixture.name)
  vi.mocked(lstatSync).mockImplementationOnce((path) => {
    expect(path).toBe(firstDirectory)
    throw denied
  })
  expect(thrownBy(() => fixture.resolveEnginePackage(fixture.name))).toBe(denied)
})
