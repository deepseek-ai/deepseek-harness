/** Mock-local unbuilt typing and native deep mocks over generated Remote declarations. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { MaybeMockedDeep } from '@vitest/spy'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { TypertRemoteNamespace, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type { RemoteMock } from '../src/index.ts'

const root = resolve(import.meta.dirname, '../../../..')
const probePath = resolve(import.meta.dirname, '__remote_proxy_probe.ts')
const artifactPath = resolve(import.meta.dirname, '__remote_proxy_artifact.d.ts')
const protocolPath = resolve(root, 'packages/typert/protocol/src/types.ts')
const proxyPath = resolve(import.meta.dirname, '../src/remote-proxy.ts')
const protocolEntry = resolve(import.meta.dirname, '__remote_protocol.d.ts')
const cordisEntry = resolve(import.meta.dirname, '__remote_cordis.d.ts')

function modulePath(path: string): string {
  return JSON.stringify(path.replaceAll('\\', '/'))
}

function virtualKey(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase()
}

function compile(source: string, artifact?: string) {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.base.client.json'), filename => ts.sys.readFile(filename))
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const options: ts.CompilerOptions = {
    ...parsed.options,
    composite: false,
    incremental: false,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    rewriteRelativeImportExtensions: false,
    types: ['node'],
    paths: {
      '@deepseek-ai/cordis': [cordisEntry],
      '@deepseek-ai/dsh-typert-protocol': [protocolEntry],
      '@deepseek-ai/fixture/remote': [artifactPath],
    },
  }
  // The real protocol and Mock alias are compiled; only unrelated Cordis/runtime assembly is excluded.
  const virtual = new Map([
    [virtualKey(probePath), source],
    [virtualKey(protocolEntry), `export * from ${modulePath(protocolPath)}\nexport { RemoteError } from ${modulePath(resolve(root, 'packages/typert/protocol/src/remote-error.ts'))}`],
    [virtualKey(cordisEntry), 'export interface Context {}\nexport interface Events {}'],
  ])
  if (artifact !== undefined) virtual.set(virtualKey(artifactPath), artifact)
  const host = ts.createCompilerHost(options, true)
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  const hidden = (path: string): boolean => path.replaceAll('\\', '/').includes('/typert.remote-client.')
  host.fileExists = path => virtual.has(virtualKey(path)) || !hidden(path) && exists(path)
  host.readFile = path => virtual.get(virtualKey(path)) ?? (hidden(path) ? undefined : read(path))
  host.getSourceFile = (path, languageVersion) => {
    const text = host.readFile(path)
    return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true)
  }
  const program = ts.createProgram([probePath], options, host)
  expect(program.getSourceFile(protocolPath)).toBeDefined()
  expect(program.getSourceFile(proxyPath)).toBeDefined()
  expect(program.getSourceFiles().some(file => hidden(file.fileName))).toBe(false)
  expect(program.getSourceFile(artifactPath) !== undefined).toBe(artifact !== undefined)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  })
  expect(diagnostics.length, formatted).toBe(0)
}

describe('RemoteMock proxy types', { timeout: 60_000 }, () => {
  it('keeps production closed while an empty generated map permits Mock calls and overrides', () => {
    compile(`
import type { TypertRemoteNamespace, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { MockedRemote } from '../src/remote-proxy.ts'
type IsAny<T> = 0 extends (1 & T) ? true : false
declare const local: MockedRemote
const loose: IsAny<MockedRemote> = true
local.fixture.echo(123, 'unbuilt')
local.fixture.echo.mockResolvedValueOnce({ arbitrary: 'answer' })
local.fixture.echo.mockImplementation((value: unknown, extra: unknown) => [value, extra])
declare const production: TypertClientRemote
declare const strict: TypertRemoteNamespace<'fixture'>
// @ts-expect-error -- Importing the Mock alias cannot add a production namespace.
production.fixture.echo('unbuilt')
// @ts-expect-error -- Production methods stay unavailable without generated declarations.
strict.echo('unbuilt')
void loose
`)
  })

  it('preserves generated arguments, results and native spy overrides', () => {
    compile(`
import type { MockedRemote } from '../src/remote-proxy.ts'
import type {} from '@deepseek-ai/fixture/remote'
type IsAny<T> = 0 extends (1 & T) ? true : false
declare const local: MockedRemote
const spy = local.fixture.echo
spy.mockImplementation(value => value.length)
const argumentIsTyped: IsAny<Parameters<typeof spy>[0]> = false
const resultIsTyped: IsAny<ReturnType<typeof spy>> = false
const result: number = spy('typed')
spy.mockReturnValueOnce(2)
// @ts-expect-error -- Generated arguments remain checked through the native spy.
spy(123)
// @ts-expect-error -- Generated return values remain checked through native overrides.
spy.mockReturnValueOnce('wrong')
// @ts-expect-error -- Known namespaces do not gain arbitrary methods.
local.fixture.missing()
// @ts-expect-error -- A non-empty map does not gain arbitrary namespaces.
local.missing.echo('wrong')
void [argumentIsTyped, resultIsTyped, result]
`, fixtureDeclaration)
  })

  it('keeps partial and empty namespaces closed inside a non-empty map', () => {
    compile(`
import type { TypertClientRemote, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import type { MockedRemote } from '../src/remote-proxy.ts'
import type {} from '@deepseek-ai/fixture/remote'
type PartialMap = { fixture: Pick<TypertRemoteNamespace<'fixture'>, 'echo'>; empty: {} }
declare const local: MockedRemote<PartialMap>
declare const production: TypertClientRemote
const known: number = local.fixture.echo('known')
// @ts-expect-error -- A partial namespace remains partial.
local.fixture.watch()
// @ts-expect-error -- Only an empty whole map enables the Mock fallback.
local.empty.echo()
// @ts-expect-error -- Local Mock types cannot open production namespace lookup.
production.notANamespace.echo()
void known
`, fixtureDeclaration)
  })

  // Ordinary built Client tsc checks these generated business types; Vitest itself remains build-free.
  it('derives real settings mocks from the generated namespace map and native deep mapping', () => {
    type Settings = RemoteMock['remote']['settings']
    type Generated = TypertRemoteNamespace<'settings'>
    expectTypeOf<RemoteMock['remote']>().toEqualTypeOf<MaybeMockedDeep<TypertRemoteNamespaceMap>>()
    expectTypeOf<ReturnType<Settings['describe']>>().not.toBeAny()
    expectTypeOf<ReturnType<Settings['update']>>().not.toBeAny()
    expectTypeOf<Parameters<Settings['update']>>().toEqualTypeOf<Parameters<Generated['update']>>()
    expectTypeOf<Parameters<Settings['update']>[1]>().not.toBeAny()
    expectTypeOf<Parameters<Settings['mutate']>>().toEqualTypeOf<Parameters<Generated['mutate']>>()
    expectTypeOf<[number, boolean, string]>().not.toExtend<Parameters<Settings['update']>>()
    expectTypeOf<{ ok: true; value: number }>().not.toExtend<Awaited<ReturnType<Settings['update']>>>()
    expectTypeOf<Settings>().not.toHaveProperty('missing')
  })

  it('retains the native/generated type dependencies only in the proxy declaration', () => {
    const source = readFileSync(proxyPath, 'utf8')
    const declaration = ts.transpileDeclaration(source, { fileName: proxyPath })
    expect(declaration.diagnostics ?? []).toHaveLength(0)
    expect(declaration.outputText).toContain('MaybeMockedDeep')
    expect(declaration.outputText).toContain('TypertRemoteNamespaceMap')
    const runtime = ts.transpileModule(source, {
      fileName: proxyPath,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    })
    expect(runtime.outputText).not.toContain('@deepseek-ai/dsh-typert-protocol')
    expect(runtime.outputText).not.toContain('@vitest/spy')
  })
})

/** Synthetic Remote methods exercise the mapping without copying business signatures. */
const fixtureDeclaration = `
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'fixture/echo': (value: string) => number
    'fixture/watch': (after: number, signal?: AbortSignal) => AsyncIterable<number>
  }
  interface TypertRemoteNamespaceMap {
    fixture: TypertRemoteNamespace<'fixture'>
  }
}
`
