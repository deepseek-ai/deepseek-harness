import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer.ts'
import type { InvocationModel } from '../src/model.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/remote-model')
const temporaryRoots: string[] = []

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

interface RuntimeSchema {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown }
}

interface RuntimeDescriptor {
  readonly id: string
  readonly mode?: 'stream'
  readonly cancellation?: { readonly parameter: 'signal' }
  readonly parameters: readonly {
    readonly wire: string
    readonly acceptsUndefined?: true
    readonly codec: { readonly create: () => RuntimeSchema }
  }[]
  readonly uplink?: {
    readonly codec: { readonly create: () => RuntimeSchema }
  }
  readonly result: {
    readonly create: () => RuntimeSchema
    readonly decode?: (value: unknown) => unknown
    readonly encode?: (value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown
  }
}

interface RuntimeRemoteModule {
  readonly TYPERT_REMOTE: {
    readonly package: string
    readonly descriptors: readonly RuntimeDescriptor[]
  }
}

interface RemoteDeclarationMap {
  readonly file: string
  readonly names: readonly string[]
  readonly sources: readonly string[]
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Remote model generation', { timeout: 60_000 }, () => {
  it('projects a generic binary result without copying or freezing its bytes', async () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}\nexport type BinaryFile<Data extends Uint8Array = Uint8Array> = {\n  readonly data: Data\n} & { readonly size: number }\n`)
    editFile(root, 'packages/remote/src/index.ts', source => `import type { BinaryFile } from './types.ts'\n${source.replace(
      '\n}\n\nexport type {',
      '\n  @Remote\n  bytes(): BinaryFile { return { data: new Uint8Array([0, 255]), size: 2 } }\n}\n\nexport type {',
    )}`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.js).not.toContain('binaryResult')
    expect(artifact?.remote?.dts).toContain('Promise<RemoteResult<RemoteDecoded<BinaryFile>>>')
    const generated = await import(`data:text/javascript,${encodeURIComponent(
      (artifact?.remote?.js ?? '').replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`),
    )}`) as RuntimeRemoteModule
    const descriptor = generated.TYPERT_REMOTE.descriptors.find(invocation => invocation.id.endsWith('/bytes'))
    expect(descriptor?.result.decode).toBeTypeOf('function')
    if (descriptor === undefined) throw new Error('binary descriptor missing')
    const schema = descriptor.result.create()
    for (const data of [new Uint8Array(), new Uint8Array([0, 128, 255]), new Uint8Array(new SharedArrayBuffer(3))]) {
      const parsed = schema.safeParse({ data, size: data.length })
      expect(parsed.success).toBe(true)
      expect((parsed.data as { readonly data: Uint8Array }).data).toBe(data)
      expect(Object.isFrozen(data)).toBe(false)
    }
    expect(schema.safeParse({ data: 'AP8=', size: 2 }).success).toBe(false)
    expect(schema.safeParse({ data: [0, 255], size: 2 }).success).toBe(false)
    expect(schema.safeParse({ data: new Uint8Array(), size: '0' }).success).toBe(false)
    expect(schema.safeParse({ size: 0 }).success).toBe(false)
    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root, `
async function readBytes() {
  const result = await ctx.remote.goals.bytes()
  if (!result.ok) return
  const data: Uint8Array<ArrayBuffer> = result.value.data
  new Blob([data])
  // @ts-expect-error binary results do not carry base64 strings.
  const base64: string = result.value.data
  // @ts-expect-error the Client bytes have ordinary ArrayBuffer backing.
  const shared: Uint8Array<SharedArrayBuffer> = result.value.data
  void base64
  void shared
}
void readBytes
`)
  })

  it.each([
    ['parameter', '@Remote\n  bytes(data: Uint8Array): number { return data.length }'],
    ['nested parameter', '@Remote\n  bytes(files: { content: Uint8Array }[]): number { return files.length }'],
    ['binary stream', "@Remote({ mode: 'stream' })\n  async *bytes(): AsyncIterable<{ data: Uint8Array }> { throw new Error() }"],
  ])('rejects unsupported binary %s', (_name, method) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      '\n}\n\nexport type {', `\n  ${method}\n}\n\nexport type {`,
    ))
    expect(() => new WorkspaceTypertGenerator(root).generate())
      .toThrow('Remote Uint8Array is only supported in unary results')
  })

  it.each([
    ['undefined data', '{ data: Uint8Array | undefined }', 'Remote boundary contains non-JSON type undefined'],
    ['unconstrained metadata', '{ data: Uint8Array; meta: unknown }', 'Remote boundary contains unconstrained unknown data'],
  ])('rejects binary results with %s', (_name, type, message) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      '\n}\n\nexport type {', `\n  @Remote\n  bytes(): ${type} { throw new Error() }\n}\n\nexport type {`,
    ))
    expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(message)
  })

  it('decodes recursive objects, arrays, tuples, unions and root bytes by their field types', async () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}
declare const fileNameBrand: unique symbol
export type FileName = string & { readonly [fileNameBrand]: true }
export type LinkedBytes = { readonly content: Uint8Array } & { readonly next?: LinkedBytes }
export interface BinaryTree {
  readonly name: FileName
  readonly content?: Uint8Array | null
  readonly files: readonly BinaryTree[]
  readonly pair: readonly [Uint8Array, { readonly raw: Uint8Array }?]
  readonly tail: readonly [string, ...Uint8Array[]]
  readonly choice: Uint8Array | { readonly preview: Uint8Array }
  readonly variants: ({ readonly content: Uint8Array } & { readonly content: Uint8Array; readonly size: number })[]
  readonly chunks: Readonly<Record<string, Uint8Array>>
}
`)
    editFile(root, 'packages/remote/src/index.ts', source => `import type { BinaryTree, LinkedBytes } from './types.ts'\n${source.replace(
      '\n}\n\nexport type {', `
  @Remote
  tree(): BinaryTree { throw new Error() }
  @Remote
  linked(): LinkedBytes { throw new Error() }
  @Remote
  raw(): Uint8Array { throw new Error() }
  @Remote
  nullable(): Uint8Array | null { throw new Error() }
  @Remote
  maybe(): Uint8Array | void { throw new Error() }
  @Remote
  array(): readonly Uint8Array[] { throw new Error() }
  @Remote
  envelope(): { readonly content?: Uint8Array; readonly metadata: { readonly title: string } } { throw new Error() }
  @Remote
  overlap(): { content: Uint8Array } | { content: Uint8Array; title: string } { throw new Error() }
  @Remote
  objectOrBytes(): { content: Uint8Array } | Uint8Array<SharedArrayBuffer> { throw new Error() }
}\n\nexport type {`,
    )}`)
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    const generated = await import(`data:text/javascript,${encodeURIComponent(
      (artifact?.remote?.js ?? '').replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`),
    )}`) as RuntimeRemoteModule
    const codec = (method: string) => {
      const descriptor = generated.TYPERT_REMOTE.descriptors.find(item => item.id.endsWith(`/${method}`))
      if (descriptor === undefined) throw new Error(`descriptor missing: ${method}`)
      return descriptor.result
    }
    const content = new Uint8Array([128, 255])
    const leaf = { name: 'leaf', files: [], pair: [content], tail: ['parts', content], choice: content, variants: [], chunks: {} }
    const value = {
      ...leaf, content, files: [{ ...leaf, content: null }], pair: [content, { raw: content }],
      choice: { preview: content }, variants: [{ content, size: 2 }], chunks: { 'a.b/c': content },
    }
    expect(codec('tree').decode?.(value)).toEqual(value)
    const parsed = codec('tree').decode?.(value) as typeof value
    expect(parsed.content).toBe(content)
    expect(Object.isFrozen(parsed.files)).toBe(true)
    expect(Object.isFrozen(parsed.pair)).toBe(true)
    expect(parsed.pair[0]).toBe(content)
    expect(parsed.variants[0]?.content).toBe(content)
    expect(parsed.tail[1]).toBe(content)
    expect(Object.isFrozen(content)).toBe(false)
    expect(codec('tree').decode?.(leaf)).toEqual(leaf)
    expect(() => codec('tree').decode?.({ ...value, files: [{ ...leaf, content: 'base64' }] })).toThrow()
    expect(() => codec('tree').decode?.({ ...value, variants: [{ content, size: '2' }] })).toThrow()
    expect(codec('raw').decode?.(content)).toBe(content)
    expect(codec('nullable').decode?.(null)).toBe(null)
    expect(codec('nullable').decode?.(content)).toBe(content)
    expect(codec('maybe').decode?.(undefined)).toBeUndefined()
    expect(codec('maybe').decode?.(content)).toBe(content)
    expect(() => codec('raw').decode?.([128, 255])).toThrow()
    expect(codec('array').decode?.([content])).toEqual([content])
    expect((codec('array').decode?.([content]) as Uint8Array[])[0]).toBe(content)
    expect(codec('create').decode).toBeUndefined()
    expect(codec('create').encode).toBeUndefined()
    const attachments: { bytes: Uint8Array; path: readonly (string | number)[] }[] = []
    const writeBytes = (bytes: Uint8Array, path: readonly (string | number)[]): null => {
      attachments.push({ bytes, path })
      return null
    }
    const metadata = codec('tree').encode?.(value, writeBytes) as typeof value
    expect(attachments.map(item => item.path)).toEqual([
      ['content'], ['files', 0, 'pair', 0], ['files', 0, 'tail', 1], ['files', 0, 'choice'],
      ['pair', 0], ['pair', 1, 'raw'], ['tail', 1], ['choice', 'preview'],
      ['variants', 0, 'content'], ['chunks', 'a.b/c'],
    ])
    expect(attachments.every(item => item.bytes === content)).toBe(true)
    expect(metadata.content).toBeNull()
    expect(metadata.files[0]?.content).toBeNull()
    expect(metadata.variants[0]?.content).toBeNull()
    expect(value.content).toBe(content)
    attachments.length = 0
    expect(codec('overlap').encode?.({ content, title: 'image' }, writeBytes)).toEqual({ content: null, title: 'image' })
    expect(attachments).toEqual([{ bytes: content, path: ['content'] }])
    attachments.length = 0
    const augmented = Object.assign(new Uint8Array(new SharedArrayBuffer(1)).fill(127), { content })
    expect(codec('objectOrBytes').encode?.(augmented, writeBytes)).toBeNull()
    expect(augmented.content).toBe(content)
    expect(attachments).toEqual([{ bytes: augmented, path: [] }])
    attachments.length = 0
    expect(codec('raw').encode?.(content, writeBytes)).toBeNull()
    expect(attachments).toEqual([{ bytes: content, path: [] }])
    expect(codec('maybe').encode?.(undefined, writeBytes)).toBeUndefined()
    const circular: { files: unknown[] } = { ...leaf, files: [] }
    circular.files.push(circular)
    expect(() => codec('tree').encode?.(circular, writeBytes)).toThrow('circular object')
    const linked: { content: Uint8Array; next?: unknown } = { content }
    linked.next = linked
    expect(() => codec('linked').encode?.(linked, writeBytes)).toThrow('circular object')
    let metadataReads = 0
    let contentReads = 0
    const opaque = { get title() { metadataReads++; return 'image' } }
    const optional = { get content() { contentReads++; return undefined }, metadata: opaque }
    const absent = codec('envelope').encode?.(optional, writeBytes) as typeof optional
    expect(absent.metadata).toBe(opaque)
    expect(metadataReads).toBe(0)
    expect(JSON.stringify(absent)).toBe('{"metadata":{"title":"image"}}')
    expect(contentReads).toBe(1)
    expect(metadataReads).toBe(1)
    let jsonCalls = 0
    const projected = codec('envelope').encode?.({ toJSON(key: string) {
      jsonCalls++
      expect(key).toBe('value')
      return { content, metadata: { title: 'image' } }
    } }, writeBytes)
    expect(JSON.stringify(projected)).toBe('{"content":null,"metadata":{"title":"image"}}')
    expect(jsonCalls).toBe(1)
    const dictionary = codec('tree').encode?.({
      ...leaf, chunks: Object.fromEntries([['__proto__', content]]),
    }, writeBytes) as typeof value
    expect(Object.hasOwn(dictionary.chunks, '__proto__')).toBe(true)
    expect((dictionary.chunks as Record<string, unknown>)['__proto__']).toBeNull()
    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root, `
import type { BinaryTree, FileName } from '@fixture/remote/types'
async function binaryTree() {
  const result = await ctx.remote.goals.tree()
  if (!result.ok) return
  const tree: BinaryTree = result.value
  const name: FileName = result.value.name
  const leaf = result.value.files[0]!
  if (leaf.content) new Blob([leaf.content])
  const pair: readonly [Uint8Array<ArrayBuffer>, { readonly raw: Uint8Array<ArrayBuffer> }?] = leaf.pair
  const choice: Uint8Array<ArrayBuffer> | { readonly preview: Uint8Array<ArrayBuffer> } = leaf.choice
  const chunk: Uint8Array<ArrayBuffer> = leaf.chunks['file']!
  // @ts-expect-error array readonly modifier is preserved.
  result.value.files.push(leaf)
  // @ts-expect-error property readonly modifier is preserved.
  result.value.name = name
  const raw = await ctx.remote.goals.raw()
  if (raw.ok) new Blob([raw.value])
  const maybe: Promise<RemoteResult<Uint8Array<ArrayBuffer> | void>> = ctx.remote.goals.maybe()
  const absent = await maybe
  if (absent.ok && absent.value !== undefined) new Blob([absent.value])
  void tree; void pair; void choice; void chunk
}
void binaryTree
`)
  })

  it('discovers a Remote-only package and emits strict direct and Context descriptors', async () => {
    const generator = new WorkspaceTypertGenerator(fixtureRoot)

    expect(generator.discover()).toEqual([{
      package: '@fixture/remote',
      root: 'packages/remote',
      faces: ['host'],
    }])

    const [artifact] = generator.generate()
    expect(artifact).toBeDefined()
    expect(artifact).toMatchObject({
      package: '@fixture/remote',
      face: 'host',
      packageRoot: 'packages/remote',
    })

    const model = remotePackage(fixtureRoot)
    expect(model.services).toEqual([])
    expect(model.invocations).toHaveLength(3)
    expect(model.invocations[0]).toMatchObject({
      id: '@fixture/remote#goals/create',
      service: 'goals',
      namespace: 'goals',
      method: 'create',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          boundary: { typeSymbol: '@fixture/domain/types#AgentId' },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          boundary: { typeSymbol: '@fixture/remote/types#CreateGoalRequest' },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: { typeSymbol: '@fixture/remote/types#CreateGoalResult' },
    })
    expect(model.invocations[1]).toMatchObject({
      id: '@fixture/remote#goals/rename',
      service: 'goals',
      namespace: 'goals',
      method: 'rename',
      invocation: {
        kind: 'context',
        context: 'agent',
        wire: 'agentId',
        boundary: { typeSymbol: '@fixture/domain/types#AgentId' },
      },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        boundary: { typeSymbol: '@fixture/remote/types#RenameGoalRequest' },
      }],
      result: { typeSymbol: '@fixture/remote/types#RenameGoalResult' },
    })
    expect(model.invocations[2]).toMatchObject({
      id: '@fixture/remote#goals/watch',
      service: 'goals',
      namespace: 'goals',
      method: 'watch',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
      }],
      cancellation: { parameter: 'signal' },
      result: { typeSymbol: '@fixture/remote/types#CreateGoalResult' },
    })

    expect(artifact?.js).toContain('invocations: [')
    expect(artifact?.remote?.dts).toContain(
      "'goals/create': (agentId: AgentId, request: CreateGoalRequest, signal?: AbortSignal) => Promise<RemoteResult<CreateGoalResult>>",
    )
    expect(artifact?.remote?.dts).toContain('interface TypertRemoteNamespace$676f616c73 {\n    create:')
    expect(artifact?.remote?.dts).toContain("'goals': TypertRemoteNamespace$676f616c73")
    expect(artifact?.remote?.dts).toContain(
      "'agent:goals/create': (request: CreateGoalRequest, signal?: AbortSignal) => Promise<RemoteResult<CreateGoalResult>>",
    )
    expect(artifact?.remote?.dts).toContain(
      "'agent:goals/rename': (request: RenameGoalRequest) => Promise<RemoteResult<RenameGoalResult>>",
    )
    expect(artifact?.remote?.dts).toContain(
      "'goals/watch': (agentId: AgentId, signal?: AbortSignal) => RemoteStreamHandle<CreateGoalResult, never>",
    )

    const remoteJs = artifact?.remote?.js
    if (remoteJs === undefined) throw new Error('Remote fixture emitted no Host-for-Client JavaScript')
    const executable = remoteJs.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
    const generated = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as RuntimeRemoteModule
    expect(generated.TYPERT_REMOTE.package).toBe('@fixture/remote')
    const create = generated.TYPERT_REMOTE.descriptors[0]
    expect(create?.cancellation).toEqual({ parameter: 'signal' })
    expect(create?.parameters[1]?.codec.create().safeParse({ title: 'ship' }).success).toBe(true)
    expect(create?.parameters[1]?.codec.create().safeParse({ title: 1 }).success).toBe(false)
    expect(create?.result.create().safeParse({ ref: 'goal-1' }).success).toBe(true)
    expect(create?.result.create().safeParse({ ref: 1 }).success).toBe(false)
    expect(generated.TYPERT_REMOTE.descriptors[2]?.mode).toBe('stream')

    const declarationMap = JSON.parse(artifact?.remote?.dtsMap ?? '') as RemoteDeclarationMap
    expect(declarationMap).toMatchObject({
      file: 'typert.remote-client.d.ts',
      sources: ['../src/index.ts'],
    })
    expect(declarationMap.names).toContain('create')

    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap)
  })

  it('projects authored optionality and absence onto consumers and codecs', async () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      '\n}\n\nexport type {',
      `

  @Remote
  maybe(value: string | undefined): string | undefined {
    return value
  }

  @Remote
  labelled(id: string, label?: string): string {
    return label ?? id
  }

  @Remote
  clear(): void {}
}

export type {`,
    ))

    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts).toContain(
      "'goals/maybe': (value: string | undefined) => Promise<RemoteResult<string | undefined>>",
    )
    expect(artifact?.remote?.dts).toContain("'goals/clear': () => Promise<RemoteResult<void>>")
    // An explicit `T | undefined` stays a required argument; only authored
    // optionality lets a consumer omit the field.
    expect(artifact?.remote?.dts).not.toContain('value?: string')
    expect(artifact?.remote?.dts).toContain("'goals/labelled': (id: string, label?: string) => Promise<RemoteResult<string>>")

    const remoteJs = artifact?.remote?.js
    if (remoteJs === undefined) throw new Error('undefined Remote fixture emitted no Host-for-Client JavaScript')
    const executable = remoteJs.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
    const generated = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as RuntimeRemoteModule
    const maybe = generated.TYPERT_REMOTE.descriptors.find(descriptor => descriptor.id.endsWith('/maybe'))
    const clear = generated.TYPERT_REMOTE.descriptors.find(descriptor => descriptor.id.endsWith('/clear'))
    expect(maybe?.parameters[0]?.acceptsUndefined).toBe(true)
    expect(maybe?.parameters[0]?.codec.create().safeParse(undefined).success).toBe(true)
    expect(maybe?.result.create().safeParse(undefined).success).toBe(true)
    expect(clear?.result.create().safeParse(undefined).success).toBe(true)
    expect(clear?.result.create().safeParse(null).success).toBe(false)
    const labelled = generated.TYPERT_REMOTE.descriptors.find(descriptor => descriptor.id.endsWith('/labelled'))
    expect(labelled?.parameters[0]?.acceptsUndefined).toBeUndefined()
    expect(labelled?.parameters[1]?.acceptsUndefined).toBe(true)
    expect(labelled?.parameters[1]?.codec.create().safeParse(undefined).success).toBe(true)
    expect(labelled?.parameters[1]?.codec.create().safeParse(7).success).toBe(false)
  })

  it('models RemoteStream return types with an uplink boundary and renders them on consumers', async () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replace(
        "import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'",
        "import { TypertRemoteService, Remote, RemoteScope, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'",
      )
      .replace(
        "  @Remote({ mode: 'stream' })\n  async *watch",
        `  @Remote({ mode: 'stream' })
  async *attach(agent: Agent, signal: AbortSignal): RemoteStream<CreateGoalResult, CreateGoalRequest> {
    signal.throwIfAborted()
    yield { ref: agent.id }
  }

  @Remote({ mode: 'stream' })
  async *tail(): RemoteStream<string> {
    yield 'tail'
  }

  @Remote({ mode: 'stream' })
  async *silent(): RemoteStream<string, never> {
    yield 'silent'
  }

  @Remote({ mode: 'stream' })
  async *watch`,
      ))

    const model = remotePackage(root)
    const attach = model.invocations.find(invocation => invocation.method === 'attach')
    expect(attach).toMatchObject({
      id: '@fixture/remote#goals/attach',
      mode: 'stream',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent' }],
      uplink: { boundary: { typeSymbol: '@fixture/remote/types#CreateGoalRequest' } },
      cancellation: { parameter: 'signal' },
      result: { typeSymbol: '@fixture/remote/types#CreateGoalResult' },
    })
    for (const method of ['tail', 'silent']) {
      const modeled = model.invocations.find(invocation => invocation.method === method)
      expect(modeled).toMatchObject({ mode: 'stream', parameters: [] })
      expect(modeled?.uplink).toBeUndefined()
      expect(modeled?.cancellation).toBeUndefined()
    }

    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts).toContain(
      "  RemoteStreamHandle,\n  TypertRemoteContribution,\n} from '@deepseek-ai/dsh-typert-protocol'",
    )
    expect(artifact?.remote?.dts).toContain("declare module '@deepseek-ai/dsh-typert-protocol' {")
    expect(artifact?.remote?.dts).toContain(
      "'goals/attach': (agentId: AgentId, signal?: AbortSignal) => RemoteStreamHandle<CreateGoalResult, CreateGoalRequest>",
    )
    expect(artifact?.remote?.dts).toContain(
      "'agent:goals/attach': (signal?: AbortSignal) => RemoteStreamHandle<CreateGoalResult, CreateGoalRequest>",
    )
    expect(artifact?.remote?.dts).toContain("'goals/tail': () => RemoteStreamHandle<string, never>")
    expect(artifact?.remote?.dts).toContain("'goals/silent': () => RemoteStreamHandle<string, never>")

    const remoteJs = artifact?.remote?.js
    if (remoteJs === undefined) throw new Error('RemoteStream fixture emitted no Host-for-Client JavaScript')
    const executable = remoteJs.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
    const generated = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as RuntimeRemoteModule
    const descriptor = generated.TYPERT_REMOTE.descriptors.find(candidate => candidate.id.endsWith('/attach'))
    expect(descriptor?.mode).toBe('stream')
    expect(descriptor?.uplink?.codec.create().safeParse({ title: 'ship' }).success).toBe(true)
    expect(descriptor?.uplink?.codec.create().safeParse({ title: 1 }).success).toBe(false)
    expect(descriptor?.cancellation).toEqual({ parameter: 'signal' })
    expect(generated.TYPERT_REMOTE.descriptors.find(candidate => candidate.id.endsWith('/tail'))?.uplink).toBeUndefined()
    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root)
  })

  it.each([
    {
      name: 'a stream method returning a Promise',
      mode: 'stream',
      method: 'async attach(agent: Agent, signal: AbortSignal): Promise<CreateGoalResult>',
      message: 'stream Remote methods must return Iterable<Out>, AsyncIterable<Out>, or RemoteStream<Out, In>',
    },
    {
      name: 'an unknown Remote mode',
      mode: 'duplex',
      method: 'async *attach(agent: Agent, signal: AbortSignal): AsyncIterable<CreateGoalResult>',
      message: 'Remote\\(\\) options must contain exactly mode: "stream"',
    },
  ])('rejects $name', ({ mode, method, message }) => {
    const root = copyFixture()
    const decorator = mode === 'unary' ? '@Remote' : `@Remote({ mode: '${mode}' })`
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      "  @Remote({ mode: 'stream' })\n  async *watch",
      `  ${decorator}\n  ${method} {\n    throw new Error('fixture never runs')\n  }\n\n  @Remote({ mode: 'stream' })\n  async *watch`,
    ))

    expect(() => analyzeRemote(root, false)).toThrow(new RegExp(message))
  })

  it('evaluates declaration-merged mapped and conditional boundaries for codecs without widening consumer types', async () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** Recursive JSON fixture used by the concrete codec projection. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Merge-extensible operation table represented by concrete fixture entries. */
export interface GenericRemoteMap {
  ship: {
    readonly request: { readonly count: number; readonly meta: Json }
    readonly result: { readonly accepted: boolean }
  }
  cancel: {
    readonly request: { readonly reason: string }
    readonly result: { readonly cancelled: boolean }
  }
}

type GenericRemoteKey = Extract<keyof GenericRemoteMap, string>
type RequestOf<K extends GenericRemoteKey> = GenericRemoteMap[K] extends { readonly request: infer Request }
  ? Request
  : never
type ResultOf<K extends GenericRemoteKey> = GenericRemoteMap[K] extends { readonly result: infer Result }
  ? Result
  : never

/** Strict request union retained in the generated Client declaration. */
export type GenericRequest = {
  [K in GenericRemoteKey]: { readonly kind: K; readonly payload: RequestOf<K> }
}[GenericRemoteKey]

/** Strict result union retained in the generated Client declaration. */
export type GenericResult = {
  [K in GenericRemoteKey]: { readonly kind: K; readonly value: ResultOf<K> }
}[GenericRemoteKey]
`)
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replace(
        '  RenameGoalResult,\n',
        '  RenameGoalResult,\n  GenericRequest,\n  GenericResult,\n',
      )
      .replace(
        "  @Remote({ mode: 'stream' })\n  async *watch",
        `  @Remote
  dispatch(request: GenericRequest): GenericResult {
    if (request.kind === 'ship') return { kind: 'ship', value: { accepted: request.payload.count > 0 } }
    return { kind: 'cancel', value: { cancelled: request.payload.reason.length > 0 } }
  }

  @Remote({ mode: 'stream' })
  async *watch`,
      ))

    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts).toContain(
      "'goals/dispatch': (request: GenericRequest) => Promise<RemoteResult<GenericResult>>",
    )
    const remoteJs = artifact?.remote?.js
    if (remoteJs === undefined) throw new Error('generic Remote fixture emitted no Host-for-Client JavaScript')
    const executable = remoteJs.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
    const generated = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as RuntimeRemoteModule
    const dispatch = generated.TYPERT_REMOTE.descriptors.find(descriptor => descriptor.id.endsWith('/dispatch'))
    const schema = dispatch?.parameters[0]?.codec.create()
    expect(schema?.safeParse({ kind: 'ship', payload: { count: 2, meta: { nested: [true, null] } } }).success).toBe(true)
    expect(schema?.safeParse({ kind: 'ship', payload: { count: '2', meta: {} } }).success).toBe(false)
    expect(schema?.safeParse({ kind: 'cancel', payload: { reason: 'obsolete' } }).success).toBe(true)
    expect(schema?.safeParse({ kind: 'unknown', payload: {} }).success).toBe(false)
    expect(dispatch?.result.create().safeParse({ kind: 'ship', value: { accepted: true } }).success).toBe(true)
    expect(dispatch?.result.create().safeParse({ kind: 'ship', value: { cancelled: true } }).success).toBe(false)
  })

  it('imports public type arguments nested under a named generic boundary', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** Generic Remote envelope. */
export interface Box<Value> {
  readonly value: Value
}

/** Payload reachable only as a generic argument. */
export interface BoxPayload {
  readonly count: number
}
`)
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replace(
        '  RenameGoalResult,\n',
        '  RenameGoalResult,\n  Box,\n  BoxPayload,\n',
      )
      .replace(
        "  @Remote({ mode: 'stream' })\n  async *watch",
        `  @Remote
  box(request: Box<BoxPayload>): Box<BoxPayload> {
    return request
  }

  @Remote({ mode: 'stream' })
  async *watch`,
      ))

    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts).toMatch(/import type \{ [^}]*Box[^}]*BoxPayload[^}]* \} from '@fixture\/remote\/types'/)
    expect(artifact?.remote?.dts).toContain('box: (request: Box<BoxPayload>) => Promise<RemoteResult<Box<BoxPayload>>>')
    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root)
  })

  it('quotes aliased methods in generated namespace interfaces', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      "  @Remote({ mode: 'stream' })\n  async *watch",
      `  @Remote('create-goal')
  createAlias(request: CreateGoalRequest): CreateGoalResult {
    return { ref: request.title }
  }

  @Remote({ mode: 'stream' })
  async *watch`,
    ))

    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts).toContain("'create-goal': (request: CreateGoalRequest) => Promise<RemoteResult<CreateGoalResult>>")
    assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root)
  })

  it.each(['create#v2', 'create goal', '.', '..'])('rejects untransportable Remote alias %s', (alias) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      '  @Remote\n  async create(',
      `  @Remote('${alias}')\n  async create(`,
    ))

    expect(() => analyzeRemote(root, false)).toThrow(/RPC endpoint segment characters/)
  })

  it('rejects a Remote export after its last Remote method is removed', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replaceAll('  @Remote\n', '')
      .replace("  @RemoteScope('agent')\n", '')
      .replace("  @Remote({ mode: 'stream' })\n", ''))
    editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** @typert schema */
export interface RemainingSchema {
  readonly value: string
}
`)

    expect(() => new WorkspaceTypertGenerator(root).generate())
      .toThrow('publishes Remote artifacts but has no Remote methods')
  })

  it('validates Remote artifacts only on the host face of a dual-face package', () => {
    const root = copyFixture()
    const manifestPath = join(root, 'packages/remote/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh?: { client?: object }
      exports: Record<string, unknown>
      files: string[]
    }
    manifest.dsh = { client: {} }
    manifest.exports['./client'] = './src/client.ts'
    manifest.exports['./client/typert'] = {
      types: './lib/typert.client.d.ts',
      default: './lib/typert.client.js',
    }
    manifest.files.push('lib/typert.client.js', 'lib/typert.client.d.ts')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(root, 'tsconfig.client.json'), `${JSON.stringify({
      extends: './tsconfig.base.json',
      files: [],
      references: [{ path: './packages/remote' }],
    }, null, 2)}\n`)
    writeFileSync(join(root, 'packages/remote/src/client.ts'), `/** @typert schema */
export interface ClientMarker {
  readonly ready: boolean
}
`)

    const artifacts = new WorkspaceTypertGenerator(root).generate()
    expect(artifacts.map(artifact => artifact.face)).toEqual(['host', 'client'])
    expect(artifacts.find(artifact => artifact.face === 'host')?.dts).not.toContain('ClientMarker')
    expect(artifacts.find(artifact => artifact.face === 'client')?.dts).toContain('ClientMarker')
  })

  it.each([
    {
      name: 'missing binding',
      edit: (source: string) => source.replace(
        "export class GoalService extends TypertRemoteService {\n  constructor() {\n    super(undefined, 'goals')\n  }",
        'export class GoalService {',
      ),
      message: 'Remote methods require TypertRemoteService',
    },
    {
      name: 'dynamic TypertRemoteService key',
      edit: (source: string) => source.replace(
        "  constructor() {\n    super(undefined, 'goals')\n  }",
        '  constructor(serviceKey: string) {\n    super(undefined, serviceKey)\n  }',
      ),
      message: 'Gateway service key must be a string literal',
    },
    {
      name: 'TypertRemoteService without a constructor',
      edit: (source: string) => source.replace(
        "  constructor() {\n    super(undefined, 'goals')\n  }\n\n",
        '',
      ),
      message: 'TypertRemoteService subclasses must declare a constructor',
    },
    {
      name: 'TypertRemoteService without a direct super call',
      edit: (source: string) => source.replace(
        "    super(undefined, 'goals')",
        '    void undefined',
      ),
      message: 'TypertRemoteService constructor must call super',
    },
    {
      name: 'TypertRemoteService super call without a service key',
      edit: (source: string) => source.replace(
        "    super(undefined, 'goals')",
        '    super(undefined)',
      ),
      message: 'TypertRemoteService super\\(\\) requires context, service key',
    },
    {
      name: 'duplicate TypertRemoteService field binding',
      edit: (source: string) => source
        .replace(
          'import { TypertRemoteService, Remote, RemoteScope }',
          'import { TypertRemoteService, Remote, RemoteScope, bindTypertRemote }',
        )
        .replace(
          'export class GoalService extends TypertRemoteService {',
          "export class GoalService extends TypertRemoteService {\n  readonly typertRemote = bindTypertRemote(this, 'goals')",
        ),
      message: 'TypertRemoteService subclasses must not declare a second typertRemote binding',
    },
    {
      name: 'private method',
      edit: (source: string) => source.replace('  async create(', '  private async create('),
      message: 'Remote decorators require a public instance method',
    },
    {
      name: 'static method',
      edit: (source: string) => source.replace('  async create(', '  static async create('),
      message: 'Remote decorators require a public instance method',
    },
    {
      name: 'abstract method',
      edit: (source: string) => source
        .replace('export class GoalService', 'export abstract class GoalService')
        .replace(
          '  async create(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): Promise<CreateGoalResult> {\n    signal.throwIfAborted()\n    return { ref: `${agent.id}:${request.title}` }\n  }',
          '  abstract create(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): Promise<CreateGoalResult>',
        ),
      message: 'Remote methods must have a concrete implementation',
    },
    {
      name: 'generic method',
      edit: (source: string) => source.replace('  async create(', '  async create<Value>('),
      message: 'generic Remote methods are not supported',
    },
    {
      name: 'destructured parameter',
      edit: (source: string) => source.replace('request: CreateGoalRequest', '{ title }: CreateGoalRequest'),
      message: 'Remote parameters must use identifier bindings',
    },
    {
      name: 'rest parameter',
      edit: (source: string) => source.replace('request: CreateGoalRequest', '...request: [CreateGoalRequest]'),
      message: 'Remote parameters cannot be rest parameters',
    },
    {
      name: 'default parameter',
      edit: (source: string) => source.replace(
        'request: CreateGoalRequest',
        "request: CreateGoalRequest = { title: '' }",
      ),
      message: 'Remote parameters cannot have default values',
    },
    {
      name: 'optional lookup parameter',
      edit: (source: string) => source.replace('agent: Agent,', 'agent?: Agent,'),
      message: 'lookup parameter for agent cannot be optional',
    },
    {
      name: 'wrong cancellation type',
      edit: (source: string) => source.replace('signal: AbortSignal', 'signal: string'),
      message: 'cancellation must use a parameter named signal with the global AbortSignal type',
    },
    {
      name: 'wrong cancellation name',
      edit: (source: string) => source.replace('signal: AbortSignal', 'abort: AbortSignal'),
      message: 'cancellation must use a parameter named signal with the global AbortSignal type',
    },
    {
      name: 'non-final cancellation',
      edit: (source: string) => source.replace(
        'agent: Agent, request: CreateGoalRequest, signal: AbortSignal',
        'agent: Agent, signal: AbortSignal, request: CreateGoalRequest',
      ),
      message: 'cancellation signal must be the final parameter',
    },
  ])('rejects $name', ({ edit, message }) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', edit)

    expect(() => analyzeRemote(root, false)).toThrow(new RegExp(message))
  })

  it('rejects a workspace class parameter without a lookup declaration', () => {
    const root = copyFixture()
    editFile(root, 'packages/domain/src/index.ts', source => source.replace(
      '  interface TypertLookupMap {\n    agent: TypertLookup<Agent, AgentId>\n  }\n\n',
      '',
    ))

    expect(() => analyzeRemote(root, false)).toThrow(/non-JSON class parameter Agent requires a TypertLookupMap entry/)
  })

  it.each([
    ['bigint', 'bigint'],
    ['symbol', 'symbol'],
    ['undefined', 'undefined'],
    ['any', 'unconstrained any'],
    ['unknown', 'unconstrained unknown'],
  ])('rejects non-JSON Remote boundary type %s', (type, message) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace(
      '  readonly title: string\n}',
      `  readonly title: string\n  readonly invalid: ${type}\n}`,
    ))

    expect(() => analyzeRemote(root, false)).toThrow(new RegExp(message))
  })

  it('keeps optional JSON object fields valid', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/types.ts', source => source.replace(
      '  readonly title: string\n}',
      '  readonly title: string\n  readonly note?: string\n}',
    ))

    expect(() => analyzeRemote(root)).not.toThrow()
  })

  it('rejects a Remote Scope without a static Context declaration', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace("@RemoteScope('agent')", "@RemoteScope('missing')"))

    expect(() => analyzeRemote(root, false)).toThrow(/Remote Scope missing has no TypertContextMap entry/)
  })

  it('rejects a direct scoped projection whose Context and lookup wire symbols differ', () => {
    const root = copyFixture()
    editFile(root, 'packages/domain/src/types.ts', source => `${source}\n/** Deliberately distinct Context identity for the failure fixture. */\nexport type OtherAgentId = string\n`)
    editFile(root, 'packages/domain/src/index.ts', source => source
      .replace("import type { AgentId } from './types.ts'", "import type { AgentId, OtherAgentId } from './types.ts'")
      .replace('agent: TypertContext<AgentId>', 'agent: TypertContext<OtherAgentId>'))

    expect(() => analyzeRemote(root, false)).toThrow(/Remote scope agent wire type .* does not match lookup wire type/)
  })

  it('rejects duplicate endpoints across Remote services', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => `${source}
export class DuplicateGoalService extends TypertRemoteService {
  constructor() {
    super(undefined, 'duplicate', { namespace: 'goals' })
  }

  @Remote
  create(request: CreateGoalRequest): CreateGoalResult {
    return { ref: request.title }
  }
}
`)

    expect(() => analyzeRemote(root, false)).toThrow(/Remote endpoint goals\/create conflicts/)
  })
})

function analyzeRemote(root: string, checkDiagnostics = true): ReturnType<WorkspaceAnalyzer['analyze']> {
  return new WorkspaceAnalyzer({ root, checkDiagnostics }).analyze()
}

function remotePackage(root: string): {
  readonly services: readonly unknown[]
  readonly invocations: readonly InvocationModel[]
} {
  const host = analyzeRemote(root).faces.find(face => face.face === 'host')
  const packageModel = host?.packages.find(candidate => candidate.name === '@fixture/remote')
  if (packageModel === undefined) throw new Error('Remote fixture package was not modeled on the host face')
  return packageModel
}

function copyFixture(sourceRoot = fixtureRoot): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-typert-remote-model-'))
  cpSync(sourceRoot, root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

function editFile(root: string, relativePath: string, edit: (source: string) => string): void {
  const path = join(root, relativePath)
  const source = readFileSync(path, 'utf8')
  const result = edit(source)
  if (result === source) throw new Error(`fixture edit made no change to ${relativePath}`)
  writeFileSync(path, result)
}

function assertRemoteConsumerTypechecks(
  dts: string | undefined,
  dtsMap: string | undefined,
  sourceRoot = fixtureRoot,
  extraConsumer = '',
): void {
  if (dts === undefined) throw new Error('Remote fixture emitted no Host-for-Client declaration')
  if (dtsMap === undefined) throw new Error('Remote fixture emitted no Host-for-Client declaration map')
  const consumerRoot = copyFixture(sourceRoot)
  const declarationPath = join(consumerRoot, 'packages/remote/lib/typert.remote-client.d.ts')
  const declarationMapPath = `${declarationPath}.map`
  const consumerPath = join(consumerRoot, 'consumer.ts')
  mkdirSync(join(consumerRoot, 'packages/remote/lib'), { recursive: true })
  writeFileSync(declarationPath, dts, { flush: true })
  writeFileSync(declarationMapPath, dtsMap, { flush: true })
  assertRemoteConsumerWithoutImportHasNoNamespace(consumerRoot)
  const consumerSource = `
import remote from '@fixture/remote/remote'
import type {
  RemoteResult,
  RemoteStreamHandle,
  TypertRemoteContribution,
  TypertRemoteScopeMap,
  TypertRemoteMap,
  TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CreateGoalResult, RenameGoalResult } from '@fixture/remote/types'

const contribution: TypertRemoteContribution = remote
declare const create: TypertRemoteMap['goals/create']
declare const createScoped: TypertRemoteScopeMap['agent:goals/create']
declare const rename: TypertRemoteScopeMap['agent:goals/rename']
declare const watch: TypertRemoteMap['goals/watch']
const created: Promise<RemoteResult<CreateGoalResult>> = create('agent-1', { title: 'ship' })
const cancellable: Promise<RemoteResult<CreateGoalResult>> = create('agent-1', { title: 'ship' }, new AbortController().signal)
const createdScoped: Promise<RemoteResult<CreateGoalResult>> = createScoped({ title: 'ship' })
const renamed: Promise<RemoteResult<RenameGoalResult>> = rename({ ref: 'goal-1', title: 'land' })
const watched: RemoteStreamHandle<CreateGoalResult, never> = watch('agent-1')
declare const ctx: { remote: TypertRemoteNamespaceMap }
const navigated: Promise<RemoteResult<CreateGoalResult>> = ctx.remote.goals.create('agent-1', { title: 'navigate' })
void contribution
void created
void cancellable
void createdScoped
void renamed
void watched
void navigated
${extraConsumer}
`
  writeFileSync(consumerPath, consumerSource)
  const configPath = join(consumerRoot, 'tsconfig.consumer.json')
  writeFileSync(configPath, JSON.stringify({
    extends: './tsconfig.base.json',
    compilerOptions: {
      composite: false,
      skipLibCheck: false,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
        '@fixture/domain/types': ['./packages/domain/src/types.ts'],
        '@fixture/remote/types': ['./packages/remote/src/types.ts'],
        '@fixture/remote/remote': ['./packages/remote/lib/typert.remote-client.d.ts'],
      },
    },
    files: ['./consumer.ts'],
  }, null, 2))
  const config = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
  if (config.error !== undefined) throw new Error(formatDiagnostics([config.error]))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, consumerRoot, undefined, configPath)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  expect(diagnostics, formatDiagnostics(diagnostics)).toEqual([])

  const languageService = ts.createLanguageService({
    getCompilationSettings: () => parsed.options,
    getCurrentDirectory: () => consumerRoot,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => parsed.fileNames,
    getScriptSnapshot: (fileName) => {
      const source = ts.sys.readFile(fileName)
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source)
    },
    getScriptVersion: () => '0',
    directoryExists: path => ts.sys.directoryExists(path),
    fileExists: path => ts.sys.fileExists(path),
    getDirectories: path => ts.sys.getDirectories(path),
    readDirectory: (path, extensions, exclude, include, depth) =>
      ts.sys.readDirectory(path, extensions, exclude, include, depth),
    readFile: path => ts.sys.readFile(path),
    realpath: path => ts.sys.realpath?.(path) ?? path,
  })
  const navigation = 'ctx.remote.goals.create'
  const position = consumerSource.indexOf(navigation) + navigation.lastIndexOf('create') + 1
  const definitions = languageService.getDefinitionAtPosition(consumerPath, position)
  const generatedDefinition = definitions?.find(candidate =>
    normalizedPath(candidate.fileName) === normalizedPath(declarationPath))
  if (generatedDefinition === undefined) {
    throw new Error(`generated Remote definition not found: ${JSON.stringify(definitions, null, 2)}`)
  }
  const sourceMapper = (languageService as unknown as {
    getSourceMapper(): {
      tryGetSourcePosition(location: { readonly fileName: string; readonly pos: number }):
      { readonly fileName: string; readonly pos: number } | undefined
    }
  }).getSourceMapper()
  const definition = sourceMapper.tryGetSourcePosition({
    fileName: generatedDefinition.fileName,
    pos: generatedDefinition.textSpan.start,
  })
  languageService.dispose()
  if (definition === undefined || !normalizedPath(definition.fileName).endsWith('/packages/remote/src/index.ts')) {
    throw new Error(`generated Remote definition did not map to its Host source: ${JSON.stringify(definition)}`)
  }
  const hostSource = readFileSync(join(consumerRoot, 'packages/remote/src/index.ts'), 'utf8')
  expect(hostSource.slice(definition.pos, definition.pos + generatedDefinition.textSpan.length)).toBe('create')
}

function assertRemoteConsumerWithoutImportHasNoNamespace(consumerRoot: string): void {
  const consumerPath = join(consumerRoot, 'consumer-without-remote.ts')
  writeFileSync(consumerPath, `
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
declare const ctx: { remote: TypertRemoteNamespaceMap }
ctx.remote.goals.create('agent-1', { title: 'must not compile' })
`)
  const configPath = join(consumerRoot, 'tsconfig.consumer-without-remote.json')
  writeFileSync(configPath, JSON.stringify({
    extends: './tsconfig.base.json',
    compilerOptions: {
      composite: false,
      skipLibCheck: false,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
      },
    },
    files: ['./consumer-without-remote.ts'],
  }, null, 2))
  const config = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
  if (config.error !== undefined) throw new Error(formatDiagnostics([config.error]))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, consumerRoot, undefined, configPath)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))
  expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(1)
  expect(diagnostics[0]?.code).toBe(2339)
  expect(ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? '', '\n')).toContain("Property 'goals' does not exist")
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
}
