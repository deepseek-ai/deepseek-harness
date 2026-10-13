import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import { executableRemoteModule } from './remote-module.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface RuntimeValue {
  create(): { parse(value: unknown): unknown }
  readonly description?: string
  readonly jsonSchema?: Record<string, unknown>
  readonly jsonSchemaError?: string
}

interface RuntimeDescriptor {
  readonly id: string
  readonly mode?: 'stream'
  readonly description?: string
  readonly parameters: readonly {
    readonly name: string
    readonly wire: string
    readonly description?: string
    readonly codec: RuntimeValue
  }[]
  readonly result: RuntimeValue
}

interface RuntimeMethod extends RuntimeDescriptor {
  input(options?: { readonly strict?: boolean }): RuntimeValue
  invoke(remote: object, input: object, signal?: AbortSignal): unknown
}

interface Generated {
  readonly TYPERT_REMOTE: {
    readonly descriptors: readonly RuntimeDescriptor[]
    readonly methods: Record<string, RuntimeMethod>
  }
}

function editFile(root: string, path: string, edit: (source: string) => string): void {
  const file = join(root, path)
  const source = readFileSync(file, 'utf8')
  const result = edit(source)
  if (result === source) throw new Error(`fixture edit made no change to ${path}`)
  writeFileSync(file, result)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-metadata-'))
  roots.push(root)
  cpSync(resolve(import.meta.dirname, 'fixtures/remote-model'), root, { recursive: true })
  editFile(root, 'packages/remote/src/index.ts', source => source.replace('  @Remote\n', `  /**
   * Create a named goal.
   * @param agent - owning Agent.
   * @param request - goal fields.
   * @param signal - request lifetime.
   * @returns the created reference.
   */
  @Remote
`))
  editFile(root, 'packages/remote/src/types.ts', source => source.replace(
    '  readonly title: string', '  /** Human-readable goal name. */\n  readonly title: string',
  ))
  return root
}

const executable = executableRemoteModule<Generated>

function assertConsumerTypechecks(root: string, dts: string, source: string): void {
  const declaration = join(root, 'packages/remote/lib/typert.remote-client.d.ts')
  mkdirSync(join(root, 'packages/remote/lib'), { recursive: true })
  writeFileSync(declaration, dts)
  const consumer = join(root, 'consumer.ts')
  writeFileSync(consumer, source)
  const config = ts.readConfigFile(join(root, 'tsconfig.base.json'), path => ts.sys.readFile(path))
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  expect(parsed.errors).toEqual([])
  const options = { ...parsed.options, composite: false, skipLibCheck: false, paths: {
    ...parsed.options.paths, '@fixture/remote/remote': [declaration],
  } }
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([consumer], options))
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
}

describe('Remote method metadata', { timeout: 60_000 }, () => {
  it('keeps selected and full-face artifacts identical when another package augments inputs and results', async () => {
    const root = fixture()
    const extension = join(root, 'packages/extension')
    mkdirSync(join(extension, 'src'), { recursive: true })
    writeFileSync(join(extension, 'package.json'), JSON.stringify({
      name: '@fixture/extension', private: true, type: 'module',
      exports: {
        '.': './src/index.ts',
        './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      },
      files: ['lib/typert.host.js', 'lib/typert.host.d.ts'],
    }))
    writeFileSync(join(extension, 'tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.base.json', include: ['src'], references: [{ path: '../remote' }],
      compilerOptions: { rootDir: 'src', outDir: 'lib/types', noEmit: false, declaration: true, emitDeclarationOnly: true },
    }))
    writeFileSync(join(extension, 'src/index.ts'), `import '@fixture/remote/types'
/** @typert schema */
export interface ExtensionMarker { readonly enabled: boolean }
declare module '@fixture/remote/types' {
  interface CreateGoalRequest { readonly extension?: { readonly label: string } }
  interface CreateGoalResult { readonly extension?: string }
}
`)
    editFile(root, 'tsconfig.host.json', (source) => {
      const config = JSON.parse(source) as { references: { path: string }[] }
      config.references.push({ path: './packages/extension' })
      return JSON.stringify(config)
    })
    const selected = new WorkspaceTypertGenerator(root).generate(['@fixture/remote'], ['host'])
    const complete = new WorkspaceTypertGenerator(root).generate(undefined, ['host'])
    expect(selected.map(artifact => artifact.package)).toEqual(['@fixture/remote'])
    expect(selected[0]).toEqual(complete.find(artifact => artifact.package === '@fixture/remote'))
    const generated = await executable(selected[0]!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'ship', extension: { label: 'installed' } } }
    for (const strict of [false, true]) {
      const view = method.input({ strict })
      expect(view.create().parse(input)).toEqual(input)
      expect(view.jsonSchema).toMatchObject({ properties: { request: {
        properties: { extension: { additionalProperties: !strict } },
      } } })
    }
    const extra = { ...input, request: { ...input.request, extension: { label: 'installed', extra: true } } }
    expect(method.input().create().parse(extra)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse(extra)).toThrow()
    const output = method.result.create()
    expect(output.parse({ ref: 'created', extension: 'installed' })).toEqual({ ref: 'created', extension: 'installed' })
    expect(() => output.parse({ ref: 'created', extension: 1 })).toThrow()
  })

  it('shares direct descriptors and codec documentation in ordinary Host and Remote artifacts', async () => {
    const [artifact] = new WorkspaceTypertGenerator(fixture()).generate()
    if (artifact?.remote === undefined) throw new Error('missing Remote artifact')
    expect(artifact.remote).not.toHaveProperty('source')
    const remote = await executable(artifact.remote.js)
    const host = await executableRemoteModule<{ TYPERT: { invocations: RuntimeDescriptor[] } }>(artifact.js)
    expect(remote).not.toHaveProperty('REMOTE_METHODS')
    expect(Object.keys(remote.TYPERT_REMOTE.methods)).toEqual(['goals/create', 'goals/watch'])
    expect(remote.TYPERT_REMOTE.descriptors).toHaveLength(3)
    const method = remote.TYPERT_REMOTE.methods['goals/create']!
    expect(method).toBe(remote.TYPERT_REMOTE.descriptors[0])
    for (const descriptors of [host.TYPERT.invocations, remote.TYPERT_REMOTE.descriptors]) {
      const current = descriptors.find(candidate => candidate.id.endsWith('/create')) as RuntimeMethod
      expect(current).toMatchObject({
        id: '@fixture/remote#goals/create', namespace: 'goals', method: 'create',
        invocation: { kind: 'direct' },
      })
      expect(current).not.toHaveProperty('metadata')
      expect(current).not.toHaveProperty('descriptor')
      expect(current).not.toHaveProperty('output')
      expect(current).not.toHaveProperty('parameterDescriptions')
      expect(current.mode).toBeUndefined()
      expect(current.description).toBe('Create a named goal.')
      expect(current.parameters).toMatchObject([
        { name: 'agent', wire: 'agentId', description: 'owning Agent.' },
        { name: 'request', wire: 'request', description: 'goal fields.' },
      ])
      for (const strict of [false, true]) {
        const input = current.input({ strict })
        expect(input.jsonSchema).toEqual(method.input({ strict }).jsonSchema)
        expect(input.jsonSchema).toMatchObject({ properties: {
          request: { description: 'goal fields.', additionalProperties: !strict, properties: { title: { description: 'Human-readable goal name.' } } },
        } })
        expect(input.jsonSchemaError).toBeUndefined()
        assertSupportedJsonSchema(input.jsonSchema)
        expect(input.create().parse({ agentId: 'agent', request: { title: 'ship' } })).toEqual({ agentId: 'agent', request: { title: 'ship' } })
        for (const invalid of [
          { request: { title: 'ship' } },
          { agentId: 'agent' },
          { agentId: 'agent', request: { title: 'ship' }, extra: true },
        ]) expect(() => input.create().parse(invalid)).toThrow()
      }
      expect(current.input().create().parse({ agentId: 'agent', request: { title: 'ship', extra: true } }))
        .toEqual({ agentId: 'agent', request: { title: 'ship' } })
      expect(() => current.input({ strict: true }).create().parse({ agentId: 'agent', request: { title: 'ship', extra: true } })).toThrow()
      expect(current.parameters[1]!.codec.create().parse({ title: 'ship', extra: true })).toEqual({ title: 'ship' })
      expect(current.result.description).toBe('the created reference.')
      expect(current.result.jsonSchema).toEqual(method.result.jsonSchema)
      expect(current.result.jsonSchema?.description).toBe('the created reference.')
      expect(current.result.jsonSchemaError).toBeUndefined()
      assertSupportedJsonSchema(current.result.jsonSchema)
      expect(current.result.create().parse({ ref: 'created' })).toEqual({ ref: 'created' })
      expect(() => current.result.create().parse({ ref: 1 })).toThrow()
      const create = vi.fn(async () => ({ ok: true, value: { ref: 'created' } }))
      const signal = new AbortController().signal
      await expect(current.invoke({ goals: { create } }, { agentId: 'agent', request: { title: 'ship' } }, signal))
        .resolves.toEqual({ ok: true, value: { ref: 'created' } })
      expect(create).toHaveBeenCalledWith('agent', { title: 'ship' }, signal)
    }
    const scoped = remote.TYPERT_REMOTE.descriptors.find(descriptor => descriptor.id.endsWith('/rename'))!
    for (const descriptor of [scoped, host.TYPERT.invocations.find(candidate => candidate.id === scoped.id)]) {
      expect(descriptor).toMatchObject({ invocation: { kind: 'context', context: 'agent' } })
      for (const key of ['metadata', 'descriptor', 'input', 'invoke']) expect(descriptor).not.toHaveProperty(key)
    }
    expect(remote.TYPERT_REMOTE.methods['goals/rename']).toBeUndefined()
    expect(remote.TYPERT_REMOTE.methods['agent:goals/rename']).toBeUndefined()
    expect(remote.TYPERT_REMOTE.methods['goals/missing']).toBeUndefined()
    expect(remote.TYPERT_REMOTE.methods['goals/watch']).toBe(remote.TYPERT_REMOTE.descriptors[2])
    expect(artifact.remote.dts).toContain('export declare const TYPERT_REMOTE: TypertRemoteInfo<{')
    expect(artifact.remote.dts).not.toContain('REMOTE_METHODS')
    expect(artifact.remote.dts).toContain("'agent:goals/rename':")
    expect(artifact.remote.dts).not.toContain("'goals/rename':")
  })

  it('emits one static method spec without runtime Host imports or eager schemas', async () => {
    const [artifact] = new WorkspaceTypertGenerator(fixture()).generate()
    if (artifact?.remote === undefined) throw new Error('missing Remote artifact')
    expect(artifact.remote.js).toContain('export const TYPERT_REMOTE = createTypertRemoteInfo({')
    expect(artifact.remote.js.match(/'goals\/create':/g)).toHaveLength(1)
    expect(artifact.remote.js).not.toMatch(/\b(?:id|namespace|method|input|invoke|metadata|output):/)
    expect(artifact.remote.js).not.toContain("wire: 'request'")
    for (const [index, source] of [artifact.js, artifact.remote.js].entries()) {
      const tree = ts.createSourceFile('artifact.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
      const imports = tree.statements.filter(ts.isImportDeclaration).map((statement) => {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error('nonliteral import')
        return statement.moduleSpecifier.text
      })
      expect(imports.sort()).toEqual(['@deepseek-ai/dsh-typert-protocol/remote-info', 'zod'])
      const parameterSpecs: ts.ObjectLiteralExpression[] = []
      const collectParameters = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'parameters') {
          if (!ts.isArrayLiteralExpression(node.initializer)) throw new Error('nonliteral parameters')
          for (const parameter of node.initializer.elements) {
            if (!ts.isObjectLiteralExpression(parameter)) throw new Error('nonliteral parameter')
            parameterSpecs.push(parameter)
          }
        }
        ts.forEachChild(node, collectParameters)
      }
      collectParameters(tree)
      expect(parameterSpecs).toHaveLength(4)
      for (const parameter of parameterSpecs) {
        const codecs = parameter.properties.filter(ts.isPropertyAssignment)
          .filter(property => ['codec', 'strictCodec'].includes(property.name.getText(tree)))
        expect(codecs.map(property => property.name.getText(tree))).toEqual(['codec', 'strictCodec'])
        for (const codec of codecs) expect(ts.isObjectLiteralExpression(codec.initializer)).toBe(true)
      }
      const states = [...source.matchAll(/^let ([\w$]+\$value)$/gm)].map(match => match[1]!)
      expect(states.length).toBeGreaterThan(0)
      const generated = await executableRemoteModule<Generated & {
        readonly TYPERT?: { readonly invocations: readonly RuntimeDescriptor[] }
        readSchemaStates(): readonly unknown[]
      }>(`${source}\nexport const readSchemaStates = () => [${states.join(', ')}]\n`)
      expect(generated.readSchemaStates()).toEqual(states.map(() => undefined))
      const method = index === 0
        ? generated.TYPERT!.invocations.find(descriptor => descriptor.id.endsWith('/create')) as RuntimeMethod
        : generated.TYPERT_REMOTE.methods['goals/create']!
      const first = method.input({ strict: index === 0 })
      const second = method.input({ strict: index !== 0 })
      expect(generated.readSchemaStates()).toEqual(states.map(() => undefined))
      first.create()
      const firstStates = generated.readSchemaStates()
      expect(firstStates.some(state => state !== undefined)).toBe(true)
      second.create()
      expect(generated.readSchemaStates().some((state, position) => state !== undefined && firstStates[position] === undefined)).toBe(true)
      expect(first.create()).toBe(first.create())
      expect(second.create()).toBe(second.create())
    }
  })

  it('generates normal and strict input views from plain Remote methods without changing result codecs', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string', `readonly title: string
  readonly metadata: { readonly label: string }
  readonly items?: readonly { readonly label: string }[]`))
    editFile(root, 'packages/remote/src/index.ts', source => source.replace('  constructor() {', `  @Remote
  echo(request: CreateGoalRequest): CreateGoalRequest { return request }

  constructor() {`))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const normal = method.input()
    const strict = method.input({ strict: true })
    expect(method.input()).toBe(normal)
    expect(method.input({})).toBe(normal)
    expect(method.input({ strict: false })).toBe(normal)
    expect(method.input({ strict: true })).toBe(strict)
    expect(strict).not.toBe(normal)
    expect(normal.create()).toBe(normal.create())
    expect(strict.create()).toBe(strict.create())
    expect(strict.create()).not.toBe(normal.create())
    expect(normal.jsonSchema).toBe(normal.jsonSchema)
    expect(strict.jsonSchema).toBe(strict.jsonSchema)
    expect(strict.jsonSchema).not.toBe(normal.jsonSchema)
    for (const [view, additionalProperties] of [[normal, true], [strict, false]] as const) {
      assertSupportedJsonSchema(view.jsonSchema)
      expect(view.jsonSchema).toMatchObject({ additionalProperties: false, properties: { request: {
        additionalProperties,
        properties: {
          metadata: { additionalProperties },
          items: { items: { additionalProperties } },
        },
      } } })
    }
    const input = { agentId: 'agent', request: { title: 'ship', metadata: { label: 'app payload' }, items: [{ label: 'first' }] } }
    expect(strict.create().parse(input)).toEqual(input)
    for (const request of [
      { ...input.request, extra: true },
      { ...input.request, metadata: { ...input.request.metadata, extra: true } },
      { ...input.request, items: [{ label: 'first', extra: true }] },
    ]) {
      const extra = { ...input, request }
      expect(validateJsonSchemaValue(normal.jsonSchema!, extra)).toEqual([])
      expect(normal.create().parse(extra)).toEqual(input)
      expect(validateJsonSchemaValue(strict.jsonSchema!, extra)).not.toEqual([])
      expect(() => strict.create().parse(extra)).toThrow()
      expect(method.parameters[1]!.codec.create().parse(request)).toEqual(input.request)
    }
    for (const view of [normal, strict]) {
      expect(() => view.create().parse({ ...input, unexpected: true })).toThrow()
      expect(validateJsonSchemaValue(view.jsonSchema!, { ...input, unexpected: true })).not.toEqual([])
    }
    const echo = generated.TYPERT_REMOTE.methods['goals/echo']!
    const extraRequest = { ...input.request, metadata: { label: 'app payload', extra: true } }
    expect(echo.input().create().parse({ request: extraRequest })).toEqual({ request: input.request })
    expect(() => echo.input({ strict: true }).create().parse({ request: extraRequest })).toThrow()
    expect(echo.result.create().parse(extraRequest)).toEqual(input.request)
    expect(echo.result.jsonSchema).toMatchObject({ additionalProperties: true, properties: { metadata: { additionalProperties: true } } })
    const create = vi.fn(async () => ({ ok: true, value: { ref: 'created' } }))
    await method.invoke({ goals: { create } }, input)
    expect(create).toHaveBeenCalledWith('agent', input.request, undefined)
  })

  it('generates undocumented methods with parsers and optional source documentation', async () => {
    const [artifact] = new WorkspaceTypertGenerator(resolve(import.meta.dirname, 'fixtures/remote-model')).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    expect(method.description).toBeUndefined()
    expect(method.parameters.map(parameter => parameter.description)).toEqual([undefined, undefined])
    expect(method.result.description).toBeUndefined()
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchemaError).toBeUndefined()
      expect(view.create().parse({ agentId: 'agent', request: { title: 'ship' } })).toEqual({ agentId: 'agent', request: { title: 'ship' } })
    }
    expect(method.result.jsonSchemaError).toBeUndefined()
    expect(method.result.create().parse({ ref: 'created' })).toEqual({ ref: 'created' })
  })

  it('projects every emitted schema into the enforced tool-schema subset', async () => {
    const [artifact] = new WorkspaceTypertGenerator(fixture()).generate()
    const remote = await executable(artifact!.remote!.js)
    const host = await executableRemoteModule<{ readonly TYPERT: { readonly invocations: readonly RuntimeDescriptor[] } }>(artifact!.js)
    let projected = 0
    let reported = 0
    const verify = (value: RuntimeValue): void => {
      if (value.jsonSchema === undefined) {
        // An unrepresentable type must say so instead of publishing a weaker schema.
        expect(value.jsonSchemaError).toContain('typert tool schema:')
        reported += 1
        return
      }
      assertSupportedJsonSchema(value.jsonSchema)
      projected += 1
    }
    for (const method of Object.values(remote.TYPERT_REMOTE.methods)) {
      verify(method.input())
      verify(method.input({ strict: true }))
      verify(method.result)
    }
    for (const descriptor of host.TYPERT.invocations) {
      for (const parameter of descriptor.parameters) verify(parameter.codec)
      verify(descriptor.result)
    }
    const expected = Object.keys(remote.TYPERT_REMOTE.methods).length * 3
      + host.TYPERT.invocations.reduce((total, descriptor) => total + descriptor.parameters.length + 1, 0)
    expect(projected + reported).toBe(expected)
    expect(projected).toBeGreaterThan(0)
  })

  it('typechecks ordinary declarations for named invocation, Context exclusion, uplink, and decoded bytes', () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/index.ts', source => `import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol'\n${source.replace('  constructor() {', `  @Remote
  bytes(): Uint8Array { return new Uint8Array([255]) }

  @Remote({ mode: 'stream' })
  async *attach(): RemoteStream<CreateGoalResult, CreateGoalRequest> { yield { ref: 'first' } }

  constructor() {`)}`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    assertConsumerTypechecks(root, artifact!.remote!.dts, `import { TYPERT_REMOTE } from '@fixture/remote/remote'
import type { InvocationDescriptor, TypertClientRemote, TypertRemoteInfo, TypertRemoteInputOptions, TypertRemoteMethod, TypertRemoteValue, RemoteResult, RemoteStreamHandle, TypertRemoteScopeMap } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateGoalRequest, CreateGoalResult } from '@fixture/remote/types'
declare const remote: TypertClientRemote
const info: TypertRemoteInfo = TYPERT_REMOTE
const method = TYPERT_REMOTE.methods['goals/create']
const typedMethod: TypertRemoteMethod<{ agentId: string; request: CreateGoalRequest }, CreateGoalResult> = method
const descriptor: InvocationDescriptor = method
const descriptors: readonly InvocationDescriptor[] = TYPERT_REMOTE.descriptors
const unaryMode: undefined = method.mode
const streamMode: 'stream' = TYPERT_REMOTE.methods['goals/attach'].mode
const direct: 'direct' = method.invocation.kind
const id: string = method.id
const codecMode: 'strict' = method.result.mode
const typeSymbol: string = method.result.typeSymbol
const keys: Record<keyof typeof TYPERT_REMOTE.methods, true> = {
  'goals/create': true, 'goals/watch': true, 'goals/bytes': true, 'goals/attach': true,
}
const parsed: { readonly agentId: string; readonly request: CreateGoalRequest } = method.input().create().parse({})
const options: TypertRemoteInputOptions = { strict: true }
const strictInput: TypertRemoteValue<typeof parsed> = method.input(options)
const strictParsed: typeof parsed = strictInput.create().parse({})
const normalInput: TypertRemoteValue<typeof parsed> = method.input({ strict: false })
// @ts-expect-error Input options are readonly.
options.strict = false
// @ts-expect-error Strict selection accepts a boolean, not a string.
method.input({ strict: 'true' })
// @ts-expect-error Input parsing requires selecting a view.
method.input.create()
// @ts-expect-error Strict input parsers retain the request type.
const wrongInput: { readonly request: string } = strictInput.create().parse({})
const output: CreateGoalResult = method.result.create().parse({})
const value: Promise<RemoteResult<CreateGoalResult>> = method.invoke(remote, parsed, new AbortController().signal)
// @ts-expect-error Invocation results retain the owner's result fields.
const wrongResult: Promise<RemoteResult<string>> = method.invoke(remote, parsed)
// @ts-expect-error Output parsers retain the owner's result fields.
const wrongOutput: string = method.result.create().parse({})
const description: string | undefined = method.description
const schema: Readonly<Record<string, unknown>> | undefined = method.input().jsonSchema
const projectionError: string | undefined = method.input().jsonSchemaError
const parameterDescription: string | undefined = method.parameters[0]?.description
const resultDescription: string | undefined = method.result.description
// @ts-expect-error The request retains the owner's title type.
method.invoke(remote, { agentId: 'agent', request: { title: 1 } })
// @ts-expect-error Required named arguments cannot be omitted.
method.invoke(remote, { agentId: 'agent' })
// @ts-expect-error A Context receiver needs scoped invocation.
TYPERT_REMOTE.methods['goals/rename']
// @ts-expect-error Scoped keys are absent from the direct-method index.
TYPERT_REMOTE.methods['agent:goals/rename']
// @ts-expect-error Unknown keys are absent from the exact method index.
TYPERT_REMOTE.methods['goals/missing']
declare const rename: TypertRemoteScopeMap['agent:goals/rename']
rename({ ref: 'goal', title: 'ship' })
// @ts-expect-error The method itself is the descriptor.
method.descriptor
// @ts-expect-error Descriptors have no separate method metadata.
method.metadata
// @ts-expect-error Results use the descriptor codec, not an output wrapper.
method.output
// @ts-expect-error Parameter documentation lives on each parameter.
method.parameterDescriptions
const stream = TYPERT_REMOTE.methods['goals/attach'].invoke(remote, {})
const typedStream: RemoteStreamHandle<CreateGoalResult, CreateGoalRequest> = stream
stream.send({ title: 'ship' })
// @ts-expect-error Uplink items retain their declared type.
stream.send({ title: 1 })
stream.end()
stream.dispose()
const watch = TYPERT_REMOTE.methods['goals/watch'].invoke(remote, { agentId: 'agent' })
const typedWatch: RemoteStreamHandle<CreateGoalResult, never> = watch
// @ts-expect-error A downlink-only method accepts no uplink items.
watch.send({ title: 'ship' })
watch.end()
watch.dispose()
async function bytes() {
  const parsed = TYPERT_REMOTE.methods['goals/bytes'].result.create().parse(new Uint8Array(new SharedArrayBuffer(1)))
  const native: Uint8Array<ArrayBufferLike> = parsed
  // @ts-expect-error Parsing does not reconstruct carrier-owned ArrayBuffer backing.
  const narrowed: Uint8Array<ArrayBuffer> = parsed
  void [native, narrowed]
  const result = await TYPERT_REMOTE.methods['goals/bytes'].invoke(remote, {})
  if (!result.ok) return
  const data: Uint8Array<ArrayBuffer> = result.value
  new Blob([data])
  // @ts-expect-error Decoded bytes have ordinary ArrayBuffer backing.
  const shared: Uint8Array<SharedArrayBuffer> = result.value
  // @ts-expect-error Binary results are not base64 strings.
  const base64: string = result.value
  void shared
  void base64
}
void [info, typedMethod, descriptor, descriptors, unaryMode, streamMode, direct, id, codecMode, typeSymbol, keys]
void [strictParsed, normalInput, wrongInput, output, value, wrongResult, wrongOutput, description, schema, projectionError, parameterDescription, resultDescription, typedStream, typedWatch, bytes]
`)
  })

  it('keeps overlapping-union input parsers and source docs when JSON Schema projection is unsupported', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string', 'readonly title: { first: string } | { second: string }'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    expect(method.description).toBe('Create a named goal.')
    expect(method.parameters.find(parameter => parameter.wire === 'request')?.description).toBe('goal fields.')
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toContain('selected union branches overlap')
      for (const title of [{ first: 'a' }, { second: 'b' }]) {
        const input = { agentId: 'agent', request: { title } }
        expect(view.create().parse(input)).toEqual(input)
        expect(method.parameters[1]!.codec.create().parse(input.request)).toEqual(input.request)
      }
      expect(() => view.create().parse({ agentId: 'agent', request: { title: {} } })).toThrow()
    }
  })

  it('keeps recursive input parsers independent when JSON Schema cannot represent them', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly next?: CreateGoalRequest'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'first', next: { title: 'second' } } }
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toContain('recursive selected type')
      expect(view.create().parse(input)).toEqual(input)
      expect(() => view.create().parse({ agentId: 'agent', request: { title: 'first', next: { title: 2 } } })).toThrow()
    }
    const extra = { agentId: 'agent', request: { title: 'first', next: { title: 'second', extra: true } } }
    expect(method.input().create().parse(extra)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse(extra)).toThrow()
    expect(method.parameters[1]!.codec.create().parse(extra.request)).toEqual(input.request)
  })

  it('supplies Zod to parameterless Host and Remote artifacts without exported schemas', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/index.ts', () => `import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
export class GoalService extends TypertRemoteService {
  constructor() { super(undefined, 'goals') }
  @Remote
  ready(): boolean { return true }
}
`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    if (artifact?.remote === undefined) throw new Error('missing Remote artifact')
    for (const source of [artifact.js, artifact.remote.js]) {
      expect(source).toContain("import { z } from 'zod'")
      expect(source).toContain('}, z)')
    }
    const host = await executableRemoteModule<{ TYPERT: { schemas: unknown[]; invocations: RuntimeMethod[] } }>(artifact.js)
    const remote = await executable(artifact.remote.js)
    expect(host.TYPERT.schemas).toEqual([])
    expect(host.TYPERT.invocations).toHaveLength(1)
    for (const method of [host.TYPERT.invocations[0]!, remote.TYPERT_REMOTE.methods['goals/ready']!]) {
      for (const strict of [false, true]) {
        const input = method.input({ strict })
        const parser = input.create()
        expect(input.create()).toBe(parser)
        expect(parser.parse({})).toEqual({})
        expect(() => parser.parse({ extra: true })).toThrow()
      }
      expect(method.result.create().parse(true)).toBe(true)
    }
  })

  it('supports optional named arguments and parameterless methods', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace('  constructor() {', `  @Remote
  ready(): boolean { return true }

  @Remote
  labelled(id: string, label?: string): string { return label ?? id }

  constructor() {`))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const ready = generated.TYPERT_REMOTE.methods['goals/ready']!
    for (const view of [ready.input(), ready.input({ strict: true })]) {
      expect(view.jsonSchema).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false })
      expect(view.create().parse({})).toEqual({})
      expect(() => view.create().parse({ extra: true })).toThrow()
    }
    const callReady = vi.fn(async () => ({ ok: true, value: true }))
    await expect(ready.invoke({ goals: { ready: callReady } }, {})).resolves.toEqual({ ok: true, value: true })
    expect(callReady).toHaveBeenCalledWith()
    const labelled = generated.TYPERT_REMOTE.methods['goals/labelled']!
    for (const view of [labelled.input(), labelled.input({ strict: true })]) {
      expect(view.jsonSchema).toMatchObject({ required: ['id'], properties: { label: { type: 'string' } } })
      for (const input of [{ id: 'goal' }, { id: 'goal', label: 'ship' }]) {
        expect(validateJsonSchemaValue(view.jsonSchema!, input)).toEqual([])
        expect(view.create().parse(input)).toEqual(input)
      }
      expect(() => view.create().parse({ label: 'ship' })).toThrow()
      expect(() => view.create().parse({ id: 'goal', label: 1 })).toThrow()
    }
    const callLabelled = vi.fn(async () => ({ ok: true, value: 'goal' }))
    await labelled.invoke({ goals: { labelled: callLabelled } }, { id: 'goal' })
    expect(callLabelled).toHaveBeenCalledWith('goal', undefined)
    assertConsumerTypechecks(root, artifact!.remote!.dts, `import { TYPERT_REMOTE } from '@fixture/remote/remote'
import type { TypertClientRemote, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
declare const remote: TypertClientRemote
const ready: Promise<RemoteResult<boolean>> = TYPERT_REMOTE.methods['goals/ready'].invoke(remote, {})
TYPERT_REMOTE.methods['goals/labelled'].invoke(remote, { id: 'goal' })
TYPERT_REMOTE.methods['goals/labelled'].invoke(remote, { id: 'goal', label: 'ship' })
// @ts-expect-error Optional labels still require strings when present.
TYPERT_REMOTE.methods['goals/labelled'].invoke(remote, { id: 'goal', label: 1 })
void ready
`)
  })

  it('preserves discriminator unions and nested unknown-field rejection in tool schemas', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      "readonly title: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'count'; readonly count: number }"))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const strict = method.input({ strict: true })
    const schema = strict.jsonSchema
    assertSupportedJsonSchema(schema)
    for (const title of [{ kind: 'text', text: 'ship' }, { kind: 'count', count: 2 }]) {
      const input = { agentId: 'agent', request: { title } }
      expect(validateJsonSchemaValue(schema, input)).toEqual([])
      expect(strict.create().parse(input)).toEqual(input)
    }
    const extra = { agentId: 'agent', request: { title: { kind: 'text', text: 'ship', count: 2 } } }
    expect(validateJsonSchemaValue(schema, extra)).not.toEqual([])
    expect(() => strict.create().parse(extra)).toThrow()
    expect(validateJsonSchemaValue(method.input().jsonSchema!, extra)).toEqual([])
    expect(method.input().create().parse(extra)).toEqual({ agentId: 'agent', request: { title: { kind: 'text', text: 'ship' } } })
  })

  it('returns the ordinary stream handle without wrapping its uplink or disposal', async () => {
    const [artifact] = new WorkspaceTypertGenerator(fixture()).generate()
    const generated = await executable(artifact!.remote!.js)
    const handle = Object.assign((async function* () { yield { ref: 'first' } })(), {
      send: vi.fn(), end: vi.fn(), dispose: vi.fn(),
    })
    const watch = vi.fn(() => handle)
    const method = generated.TYPERT_REMOTE.methods['goals/watch']!
    expect(method.mode).toBe('stream')
    const signal = new AbortController().signal
    expect(method.invoke({ goals: { watch } }, { agentId: 'agent' }, signal)).toBe(handle)
    expect(watch).toHaveBeenCalledWith('agent', signal)
    const items = []
    for await (const item of handle) items.push(item)
    expect(items).toEqual([{ ref: 'first' }])
  })

  it('projects canonical JsonValue and JSON dictionaries without recursive schema references', async () => {
    const root = fixture()
    const directory = join(root, 'packages/json-values-fixture')
    mkdirSync(join(directory, 'src'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-util-values', exports: { '.': './src/index.ts' } }))
    writeFileSync(join(directory, 'tsconfig.json'), readFileSync(join(root, 'packages/domain/tsconfig.json'), 'utf8'))
    writeFileSync(join(directory, 'src/index.ts'), 'export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n')
    editFile(root, 'tsconfig.host.json', (source) => {
      const config = JSON.parse(source) as { references: { path: string }[] }
      config.references.push({ path: './packages/json-values-fixture' })
      return JSON.stringify(config)
    })
    editFile(root, 'tsconfig.base.json', (source) => {
      const config = JSON.parse(source) as { compilerOptions: { paths: Record<string, string[]> } }
      config.compilerOptions.paths['@deepseek-ai/dsh-util-values'] = ['./packages/json-values-fixture/src/index.ts']
      return JSON.stringify(config)
    })
    editFile(root, 'packages/remote/src/types.ts', source => "import type { JsonValue } from '@deepseek-ai/dsh-util-values'\n" + source
      .replace('readonly title: string', 'readonly title: string\n  readonly payload: JsonValue\n  readonly labels?: Record<string, JsonValue>'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'ship', payload: [null, { nested: [true, 3] }], labels: { tag: ['a', 'b'], extra: { nested: true } } } }
    for (const strict of [false, true]) {
      const view = method.input({ strict })
      const schema = view.jsonSchema
      assertSupportedJsonSchema(schema)
      expect(JSON.stringify(schema)).not.toContain('$ref')
      expect(schema).toMatchObject({ properties: { request: {
        additionalProperties: !strict,
        properties: { payload: {}, labels: { type: 'object', additionalProperties: true } },
      } } })
      expect(validateJsonSchemaValue(schema, input)).toEqual([])
      expect(view.create().parse(input)).toEqual(input)
      expect(() => view.create().parse({ agentId: 'agent', request: { title: 'ship', payload: undefined } })).toThrow()
    }
  })

  it('keeps typed dictionary keys open when input JSON Schema is unsupported', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly labels: Record<string, string>'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'ship', labels: { first: 'a', extra: 'b' } } }
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toContain('selected dictionaries require string keys and unconstrained JSON values')
      expect(view.create().parse(input)).toEqual(input)
      expect(() => view.create().parse({ ...input, request: { title: 'ship', labels: { first: 1 } } })).toThrow()
    }
    const extra = { ...input, request: { ...input.request, extra: true } }
    expect(method.input().create().parse(extra)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse(extra)).toThrow()
  })

  it('retains tuple input parsers under both policies without requiring a tool projection', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: readonly [{ readonly first: string }, { readonly second: string }]'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: [{ first: 'one' }, { second: 'two' }] } }
    for (const strict of [false, true]) {
      const view = method.input({ strict })
      expect(view.create().parse(input)).toEqual(input)
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toContain('tuple')
    }
    const extra = { agentId: 'agent', request: { title: [{ first: 'one', extra: true }, { second: 'two' }] } }
    expect(method.input().create().parse(extra)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse(extra)).toThrow()
  })

  it('keeps declared dictionary properties more specific than the index value', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly payload: { readonly fixed: { readonly a: string; readonly b: string }; readonly [key: string]: { readonly a: string } }'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'ship', payload: { fixed: { a: 'a', b: 'b' }, extra: { a: 'extra' } } } }
    for (const strict of [false, true]) {
      const view = method.input({ strict })
      expect(view.create().parse(input)).toEqual(input)
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toContain('selected dictionaries')
    }
    const withExtraValue = { ...input, request: { ...input.request, payload: { ...input.request.payload, extra: { a: 'extra', b: 'not declared' } } } }
    expect(method.input().create().parse(withExtraValue)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse(withExtraValue)).toThrow()
  })

  it('enforces index values on named fields without rejecting their merged nested fields', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly payload: Record<string, { readonly base: string }> & { readonly fixed: { readonly own: string } }'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const valid = { agentId: 'agent', request: { title: 'ship', payload: {
      fixed: { base: 'common', own: 'specific' }, extra: { base: 'value' },
    } } }
    const strict = method.input({ strict: true })
    expect(strict.jsonSchema).toBeUndefined()
    expect(strict.jsonSchemaError).toContain('selected dictionaries')
    for (const view of [method.input(), strict]) {
      expect(view.create().parse(valid)).toEqual(valid)
      expect(() => view.create().parse({ ...valid, request: { ...valid.request, payload: {
        ...valid.request.payload, fixed: { own: 'specific' },
      } } })).toThrow()
    }
    expect(() => strict.create().parse({ ...valid, request: { ...valid.request, payload: {
      ...valid.request.payload, fixed: { base: 'common' },
    } } })).toThrow()
    expect(() => strict.create().parse({ ...valid, request: { ...valid.request, payload: {
      ...valid.request.payload, fixed: { ...valid.request.payload.fixed, unexpected: true },
    } } })).toThrow()
    expect(() => strict.create().parse({ ...valid, request: { ...valid.request, payload: {
      ...valid.request.payload, extra: { base: 'value', unexpected: true },
    } } })).toThrow()
    expect(() => strict.create().parse({ ...valid, request: { ...valid.request, payload: {
      ...valid.request.payload, extra: { own: 'missing base' },
    } } })).toThrow()
    const outer = { ...valid, request: { ...valid.request, payload: { ...valid.request.payload, extraOuter: true } } }
    expect(() => strict.create().parse(outer)).toThrow()
  })

  it('merges overlapping indexed fields before closing their nested objects', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly payload: Record<string, { readonly base: string; readonly nested: { readonly left: string } }> & { readonly fixed: { readonly own: string; readonly nested: { readonly right: string } } }'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const strict = generated.TYPERT_REMOTE.methods['goals/create']!.input({ strict: true })
    const fixed = { base: 'common', own: 'specific', nested: { left: 'index', right: 'declared' } }
    const input = { agentId: 'agent', request: { title: 'ship', payload: { fixed } } }
    expect(strict.create().parse(input)).toEqual(input)
    for (const nested of [{ right: 'declared' }, { left: 'index' }, { ...fixed.nested, extra: true }]) {
      expect(() => strict.create().parse({ ...input, request: { ...input.request, payload: {
        fixed: { ...fixed, nested },
      } } })).toThrow()
    }
  })

  it('keeps a shared indexed value type valid for a named field', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}\ntype Entry = { readonly base: string }\n`)
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      'readonly title: string\n  readonly payload: Record<string, Entry> & { readonly fixed: Entry }'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const strict = generated.TYPERT_REMOTE.methods['goals/create']!.input({ strict: true })
    const input = { agentId: 'agent', request: { title: 'ship', payload: { fixed: { base: 'common' } } } }
    expect(strict.create().parse(input)).toEqual(input)
    expect(() => strict.create().parse({ ...input, request: { ...input.request, payload: {
      fixed: { base: 'common', extra: true },
    } } })).toThrow()
  })

  it.each([
    {
      name: 'a union of named object fields',
      type: 'Record<string, { base: string }> & { fixed: { own: string } | { other: number } }',
      valid: [{ base: 'base', own: 'own' }, { base: 'base', other: 1 }],
      invalid: [{ own: 'own' }, { other: 1 }, { base: 'base' }, null],
      optional: false,
    },
    {
      name: 'an optional named field',
      type: 'Record<string, { base: string }> & { fixed?: { own: string } }',
      valid: [{ base: 'base', own: 'own' }],
      invalid: [{ own: 'own' }, { base: 'base' }, null],
      optional: true,
    },
    {
      name: 'a nullable index value',
      type: 'Record<string, { base: string } | null> & { fixed: { own: string } }',
      valid: [{ base: 'base', own: 'own' }],
      invalid: [{ own: 'own' }, { base: 'base' }, null],
      optional: false,
    },
    {
      name: 'unions on both the named field and index value',
      type: 'Record<string, { base: string } | null> & { fixed: { own: string } | null }',
      valid: [{ base: 'base', own: 'own' }, null],
      invalid: [{ own: 'own' }, { base: 'base' }],
      optional: false,
    },
  ])('combines indexed constraints for $name before closing objects', async ({ type, valid, invalid, optional }) => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace('readonly title: string',
      `readonly title: string\n  readonly payload: ${type}`))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = (payload: object) => ({ agentId: 'agent', request: { title: 'ship', payload } })
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchema).toBeUndefined()
      expect(view.jsonSchemaError).toMatch(/selected dictionaries|selected union branches/)
      for (const fixed of valid) expect(view.create().parse(input({ fixed }))).toEqual(input({ fixed }))
      for (const fixed of invalid) expect(() => view.create().parse(input({ fixed }))).toThrow()
      if (optional) expect(view.create().parse(input({}))).toEqual(input({}))
      else expect(() => view.create().parse(input({}))).toThrow()
    }
    for (const fixed of valid) {
      if (fixed === null) continue
      const extra = input({ fixed: { ...fixed, unexpected: true } })
      expect(method.input().create().parse(extra)).toEqual(input({ fixed }))
      expect(() => method.input({ strict: true }).create().parse(extra)).toThrow()
    }
  })

  it('keeps normal and closed recursive helper identifiers distinct', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}\nexport interface Branch { readonly value: string; readonly next?: Branch }\nexport interface closed$Branch { readonly value: string; readonly next?: closed$Branch }\n`)
    editFile(root, 'packages/remote/src/index.ts', source => `import type { Branch, closed$Branch } from './types.ts'\n${source.replace('  constructor() {', `  @Remote
  recursive(request: Branch): closed$Branch { return request }

  constructor() {`)}`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const input = { request: { value: 'first', next: { value: 'second' } } }
    for (const source of [artifact!.js, artifact!.remote!.js]) {
      await executableRemoteModule(source)
      const variables = ts.createSourceFile('artifact.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS).statements
        .filter(ts.isVariableStatement)
        .flatMap(statement => statement.declarationList.declarations.map(declaration => declaration.name.getText()))
      expect(new Set(variables).size).toBe(variables.length)
    }
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/recursive']!
    expect(method.input().create().parse(input)).toEqual(input)
    expect(method.input({ strict: true }).create().parse(input)).toEqual(input)
    expect(() => method.input({ strict: true }).create().parse({ request: { value: 'first', next: { value: 'second', extra: true } } })).toThrow()
    expect(method.result.create().parse(input.request)).toEqual(input.request)
  })

  it('projects real nominal primitive brands without treating the marker as an object', async () => {
    const root = fixture()
    const real = resolve(import.meta.dirname, '../../../util/brand')
    const destination = join(root, 'packages/util/brand')
    mkdirSync(join(destination, 'src'), { recursive: true })
    for (const file of ['package.json', 'tsconfig.json', 'src/index.ts']) {
      writeFileSync(join(destination, file), readFileSync(join(real, file)))
    }
    editFile(root, 'tsconfig.host.json', (source) => {
      const config = JSON.parse(source) as { references: { path: string }[] }
      config.references.push({ path: './packages/util/brand' })
      return JSON.stringify(config)
    })
    editFile(root, 'tsconfig.base.json', (source) => {
      const config = JSON.parse(source) as { compilerOptions: { paths: Record<string, string[]> } }
      config.compilerOptions.paths['@deepseek-ai/dsh-brand'] = ['./packages/util/brand/src/index.ts']
      return JSON.stringify(config)
    })
    editFile(root, 'packages/domain/src/types.ts', () => `import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable nominal Agent identity. */
export type AgentId = Branded<'AgentId'>
`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    for (const view of [method.input(), method.input({ strict: true })]) {
      expect(view.jsonSchema).toMatchObject({ properties: { agentId: { type: 'string' } } })
      expect(view.create().parse({ agentId: 'agent', request: { title: 'ship' } }))
        .toEqual({ agentId: 'agent', request: { title: 'ship' } })
    }
    expect(artifact!.remote!.dts).toContain("readonly 'agentId': AgentId")
  })

  it('closes merged object intersections once, including nested request objects', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace(/export interface CreateGoalRequest \{[\s\S]*?\n\}/,
      `export type CreateGoalRequest = {
  readonly title: string
  readonly nested: { readonly alpha: string } & { readonly beta: number }
} & { readonly priority: number }`))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const method = generated.TYPERT_REMOTE.methods['goals/create']!
    const input = { agentId: 'agent', request: { title: 'ship', nested: { alpha: 'a', beta: 2 }, priority: 3 } }
    const strict = method.input({ strict: true })
    const schema = strict.jsonSchema
    assertSupportedJsonSchema(schema)
    expect(validateJsonSchemaValue(schema, input)).toEqual([])
    expect(strict.create().parse(input)).toEqual(input)
    const extra = { ...input, request: { ...input.request, nested: { ...input.request.nested, extra: true } } }
    expect(validateJsonSchemaValue(schema, extra)).not.toEqual([])
    expect(() => strict.create().parse(extra)).toThrow()
    expect(validateJsonSchemaValue(method.input().jsonSchema!, extra)).toEqual([])
    expect(method.input().create().parse(extra)).toEqual(input)
  })

  it('retains output codecs and source docs when optional JSON Schema projection is unsupported', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace('Promise<CreateGoalResult>', 'Promise<readonly [string, number]>')
      .replace('return { ref: `${agent.id}:${request.title}` }', 'return [agent.id, request.title.length]'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const output = generated.TYPERT_REMOTE.methods['goals/create']!.result
    expect(output.description).toBe('the created reference.')
    expect(output.jsonSchema).toBeUndefined()
    expect(output.jsonSchemaError).toContain('unsupported selected tuple type')
    expect(output.create().parse(['goal', 2])).toEqual(['goal', 2])
    expect(() => output.create().parse(['goal', 'not-number'])).toThrow()
  })

  it('keeps recursive codec references valid when removing a nominal object marker', async () => {
    const root = fixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace(/export interface CreateGoalResult \{[\s\S]*?\n\}/, `declare const nodeBrand: unique symbol
export type CreateGoalResult = { readonly ref: string; readonly next?: CreateGoalResult } & { readonly [nodeBrand]: 'node' }`))
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replace('return { ref: `${agent.id}:${request.title}` }', 'return { ref: `${agent.id}:${request.title}` } as CreateGoalResult')
      .replace('yield { ref: agent.id }', 'yield { ref: agent.id } as CreateGoalResult'))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await executable(artifact!.remote!.js)
    const output = generated.TYPERT_REMOTE.methods['goals/create']!.result
    expect(output.jsonSchema).toBeUndefined()
    expect(output.jsonSchemaError).toContain('recursive selected type')
    expect(output.create().parse({ ref: 'first', next: { ref: 'second' } }))
      .toEqual({ ref: 'first', next: { ref: 'second' } })
    expect(() => output.create().parse({ ref: 'first', next: { ref: 2 } })).toThrow()
  })
})
