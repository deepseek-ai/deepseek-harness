/**
 * A fork child's limit driven through the real tool runtime, the real local filesystem, and the
 * shipped `read`/`write` tools.
 *
 * Everything the child's execution touches here is production code: `ToolRuntime` runs the pipeline
 * and its monotonic guard stage, `LocalFileSystem` resolves the paths, and the tools are the ones the
 * deployment registers. A permitted read must reach the tool body and return file content; a path
 * outside the granted workspace, a symlink escape, a write, a permitted name the child registered for
 * itself, and a released limit must all be refused before anything runs.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { installForkEnforcement, installSourceSessionAccess } from '../src/host/fork-enforcement.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { forkToolGuard, installChildEnforcement, type ForkToolExecution } from '../src/host/fork-tool-guard.ts'
import { READ_ONLY_FORK_CEILING } from '../src/host/fork-policy.ts'
import { describeSharedTool } from '../src/host/shared-tools.ts'
import { executeOneTool } from './tool-call.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const childSessionId = 'child-1'
const viewer = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }
const testToolSignal = new AbortController().signal

/** The child's live handle: the loop's own object carries the scope it registered into. */
type ChildAgent = Agent & { readonly ctx: Context }

/** A session-scoped Agent stand-in the real tool runtime can drive without an AgentLoop. */
function standInAgent(id: SessionId, cwd: string): Omit<Agent, 'ctx'> {
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  const unsupported = (): never => { throw new Error('this test Agent does not support Inbox mutations') }
  return {
    id,
    options: {},
    model: { current: () => undefined, select: () => {} },
    session,
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported,
    },
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}

let root: string
let outside: string
/** The temp tree this test allocated, so cleanup removes exactly what the test owns. */
let tree: string
let granted: FsTarget
let ctx: Context
let scope: Scope
let child: ChildAgent
let forks: ForkRegistry
let calls = 0

/** The host's own argument reader: each tool's own arguments name its paths. */
function describeTool(execution: ForkToolExecution) {
  return describeSharedTool(execution.name, execution.arguments)
}

/** Install the child's limit against the real capabilities this context provides. */
function installLimit(): (() => void) | undefined {
  return installForkEnforcement({
    childSessionId,
    childContext: scope.ctx,
    childScope: child,
    grantedRoot: granted,
    cwd: root,
    resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: child.session.id }),
    fs: ctx.fs,
    tools: ctx.tools,
    forks,
    describe: describeTool,
  })
}

/** Run one tool as the child, exactly as the loop would. */
function call(name: string, args: unknown) {
  calls += 1
  return executeOneTool(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`call-${String(calls)}`),
    name,
    arguments: args,
    agent: child,
  })
}

/** The model-facing text of one result. */
function text(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

beforeEach(async () => {
  // The granted root is nested so its own ancestor can be replaced in one of the tests below.
  tree = mkdtempSync(join(tmpdir(), 'liveshare-child-'))
  root = join(tree, 'granted', 'leaf')
  mkdirSync(root, { recursive: true })
  outside = mkdtempSync(join(tmpdir(), 'liveshare-child-outside-'))
  writeFileSync(join(root, 'inside.ts'), 'export const inside = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'owner-only\n')
  // A link the child can name from inside its workspace, whose target is not inside it.
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))

  ctx = new Context()
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolFs)

  const key: Omit<ChildAgent, 'ctx'> = standInAgent(SessionId(childSessionId), root)
  let minted: Scope | undefined
  await ctx.plugin(Object.assign(
    (inner: Context) => { minted = createScope(inner, key) },
    { inject: ['tools', 'fs', 'systemPrompt'] },
  ))
  if (minted === undefined) throw new Error('the child scope was not minted')
  scope = minted
  child = Object.assign(key, { ctx: scope.ctx })
  forks = new ForkRegistry(join(root, '.forks.json'))
  await forks.record({
    childSessionId,
    shareId: 'share-1',
    sourceSessionId: 'session-1',
    boundary: 3,
    creator: viewer,
    createdAt: '2026-09-12T00:00:00.000Z',
  })
  granted = await ctx.fs.resolve(root)
})

afterEach(async () => {
  try {
    await scope.dispose()
    await ctx.fiber.dispose()
  } finally {
    // The whole tree this test allocated, removed even when disposal failed: a test must not leave
    // anything behind, and only the roots it created are touched.
    rmSync(tree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

describe('fork child tool execution', () => {
  it('preserves read-before-write observations for a writable child', async () => {
    await ctx.plugin(FsObservationPolicy)
    const dispose = installForkEnforcement({
      childSessionId, childContext: scope.ctx, childScope: child, grantedRoot: granted, cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: child.session.id }),
      fs: ctx.fs, tools: ctx.tools, forks, describe: describeTool, write: true,
    })
    expect(dispose).toBeDefined()
    const path = join(root, 'inside.ts')
    expect((await call('write', { file_path: path, content: 'unread' })).isError).toBe(true)
    expect((await call('read', { file_path: path })).isError).toBe(false)
    expect((await call('write', { file_path: path, content: 'observed' })).isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('observed')
    dispose?.()
  })
  it('denies writes after the current share is narrowed and denies every tool after revocation', async () => {
    let writable = true
    const dispose = installForkEnforcement({
      childSessionId, childContext: scope.ctx, childScope: child, grantedRoot: granted, cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: child.session.id }),
      fs: ctx.fs, tools: ctx.tools, forks, describe: describeTool, write: true,
      authorized: tool => tool !== 'write' || writable,
    })
    expect(dispose).toBeDefined()
    const path = join(root, 'child-write.txt')
    expect((await call('write', { file_path: path, content: 'before' })).isError).toBe(false)
    writable = false
    expect((await call('write', { file_path: path, content: 'after' })).isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('before')
    expect((await call('read', { file_path: path })).isError).toBe(false)
    await forks.revokeShare('share-1', new Date().toISOString())
    expect((await call('read', { file_path: path })).isError).toBe(true)
    expect((await call('write', { file_path: path, content: 'revoked' })).isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('before')
    dispose?.()
  })
  it('allows a real read inside the granted workspace and returns the file', async () => {
    expect(installLimit()).toBeDefined()
    expect(forks.enforcementInstalled(childSessionId)).toBe(true)

    const result = await call('read', { file_path: join(root, 'inside.ts') })

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('export const inside = 1')
    // The read renders the file the child was granted under its canonical path.
    const target = await ctx.fs.resolve(join(root, 'inside.ts'))
    expect(text(result)).toContain(ctx.fs.processPath(target))
    expect(JSON.stringify(result)).not.toContain('/dev/fd')
  })

  it('reinstalls a released limit on the same child without retaining an obsolete denial', async () => {
    const path = join(root, 'inside.ts')
    const first = installLimit()
    expect(first).toBeDefined()
    expect((await call('read', { file_path: path })).isError).toBe(false)

    first?.()
    expect((await call('read', { file_path: path })).isError).toBe(true)
    const second = installLimit()
    expect(second).toBeDefined()
    try {
      // An obsolete disposer must not revoke its successor's enforcement record.
      first?.()
      expect(forks.enforcementInstalled(childSessionId)).toBe(true)
      const result = await call('read', { file_path: path })
      expect(result.isError).toBe(false)
      expect(text(result)).toContain('export const inside = 1')
      expect((await call('read', { file_path: join(outside, 'secret.txt') })).isError).toBe(true)
      expect((await call('write', { file_path: path, content: 'unconfined' })).isError).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe('export const inside = 1\n')
    } finally {
      second?.()
    }
    expect((await call('read', { file_path: path })).isError).toBe(true)
  })

  it('refuses an outside path and a symlink escape without running the tool body', async () => {
    installLimit()

    const outsideResult = await call('read', { file_path: join(outside, 'secret.txt') })
    expect(outsideResult.isError).toBe(true)
    expect(text(outsideResult)).toMatch(/workspace it was granted/u)
    expect(text(outsideResult)).not.toContain('owner-only')

    // The path is inside the workspace; the file it resolves to is not.
    const escaped = await call('read', { file_path: join(root, 'link.txt') })
    expect(escaped.isError).toBe(true)
    expect(text(escaped)).toMatch(/workspace it was granted/u)
    expect(text(escaped)).not.toContain('owner-only')
  })

  it('refuses the shipped write and edit tools and leaves the workspace unchanged', async () => {
    installLimit()
    const target = join(root, 'written.txt')

    const result = await call('write', { file_path: target, content: 'written by the child\n' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/may not use write/u)
    expect(existsSync(target)).toBe(false)

    const edited = await call('edit', {
      file_path: join(root, 'inside.ts'), old_string: 'export const inside = 1', new_string: 'export const inside = 2',
    })
    expect(edited.isError).toBe(true)
    expect(text(edited)).toMatch(/may not use edit/u)
    expect(readFileSync(join(root, 'inside.ts'), 'utf8')).toBe('export const inside = 1\n')
  })

  it.each(['grep', 'glob'])('confines %s to the granted workspace and supplies its default root', async (name) => {
    const calls: unknown[] = []
    ctx.tools.register(defineTool({
      name,
      description: 'a deployment search fixture',
      parameters: {
        pattern: { type: 'string', required: true, description: 'search pattern' },
        path: { type: 'string', description: 'optional search root' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { calls.push(args); return Promise.resolve('search ran') },
    }))
    expect(installLimit()).toBeDefined()
    const canonicalRoot = ctx.fs.processPath(await ctx.fs.resolve(root))

    // A pathless search reads the Session's working directory, which the replacement supplies explicitly.
    const pathless = await call(name, { pattern: '**/*.ts' })
    expect(pathless.isError).toBe(false)
    expect(calls.at(-1)).toEqual({ pattern: '**/*.ts', path: canonicalRoot })

    // A named directory inside the grant is resolved and handed over canonically.
    const inside = join(root, 'inside.ts')
    const named = await call(name, { pattern: 'inside', path: dirname(inside) })
    expect(named.isError).toBe(false)
    expect(calls.at(-1)).toEqual({ pattern: 'inside', path: ctx.fs.processPath(await ctx.fs.resolve(dirname(inside))) })

    // Outside the grant the guard refuses before the fixture body runs.
    const before = calls.length
    const outsideSearch = await call(name, { pattern: 'secret', path: outside })
    expect(outsideSearch.isError).toBe(true)
    expect(text(outsideSearch)).toMatch(/workspace it was granted/u)
    expect(calls.length).toBe(before)
  })

  it('confines image reads and deliveries, and admits the tools with no file effect', async () => {
    const calls: { tool: string; args: unknown }[] = []
    const fixture = (name: string, parameters: ParameterSchemaSpec) => ctx.tools.register(defineTool({
      name,
      description: `a deployment ${name} fixture`,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { calls.push({ tool: name, args }); return Promise.resolve(`${name} ran`) },
    }))
    fixture('read_image', { file_path: { type: 'string', required: true } })
    fixture('present', {
      files: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: { path: { type: 'string', required: true }, description: { type: 'string' } },
        },
      },
    })
    for (const name of ['todo_write', 'skill', 'web_search', 'web_fetch']) fixture(name, {})
    expect(installLimit()).toBeDefined()

    await ctx.fs.resolve(root)
    const image = await call('read_image', { file_path: join(root, 'inside.ts') })
    expect(image.isError).toBe(false)
    expect(calls.at(-1)).toEqual({
      tool: 'read_image', args: { file_path: ctx.fs.processPath(await ctx.fs.resolve(join(root, 'inside.ts'))) },
    })
    const outsideImage = await call('read_image', { file_path: join(outside, 'secret.txt') })
    expect(outsideImage.isError).toBe(true)
    expect(text(outsideImage)).toMatch(/workspace it was granted/u)

    const delivered = await call('present', {
      files: [{ path: join(root, 'inside.ts'), description: 'inside' }],
    })
    expect(delivered.isError).toBe(false)
    expect(calls.at(-1)).toEqual({
      tool: 'present',
      args: { files: [{ path: ctx.fs.processPath(await ctx.fs.resolve(join(root, 'inside.ts'))), description: 'inside' }] },
    })
    // One entry outside the grant refuses the whole delivery: nothing is presented.
    const before = calls.length
    const escaped = await call('present', {
      files: [{ path: join(root, 'inside.ts') }, { path: join(outside, 'secret.txt') }],
    })
    expect(escaped.isError).toBe(true)
    expect(text(escaped)).toMatch(/workspace it was granted/u)
    expect(calls.length).toBe(before)

    // A tool with no local file effect needs no path, and its arguments reach it unchanged.
    for (const name of ['todo_write', 'skill', 'web_search', 'web_fetch']) {
      const result = await call(name, { value: name })
      expect(result.isError).toBe(false)
      expect(calls.at(-1)).toEqual({ tool: name, args: { value: name } })
    }
  })

  it('refuses every capability the shared surface does not name', async () => {
    let ran = 0
    for (const name of ['bash', 'pwsh', 'cua', 'plugin_manager', 'schedule_create', 'ghost']) {
      ctx.tools.register(defineTool({
        name,
        description: `a deployment ${name} fixture`,
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => { ran += 1; return Promise.resolve('ran') },
      }))
    }
    expect(installLimit()).toBeDefined()

    for (const name of ['bash', 'pwsh', 'cua', 'plugin_manager', 'schedule_create', 'ghost']) {
      const result = await call(name, {})
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`may not use ${name}`)
    }
    // Registration alone is not permission: no body ran.
    expect(ran).toBe(0)
  })

  it('refuses a relative path that leaves the grant and accepts one that stays inside it', async () => {
    installLimit()
    const inside = await call('read', { file_path: 'inside.ts' })
    expect(inside.isError).toBe(false)
    expect(text(inside)).toContain('export const inside = 1')

    const escape = await call('read', { file_path: join('..', 'secret.txt') })
    expect(escape.isError).toBe(true)
    expect(text(escape)).toMatch(/workspace it was granted/u)
  })

  it('refuses a search root that is a link out of the grant', async () => {
    const linked = join(root, 'linked-out')
    symlinkSync(outside, linked)
    const calls: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'glob',
      description: 'a deployment search fixture',
      parameters: {
        pattern: { type: 'string', required: true },
        path: { type: 'string' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { calls.push(args); return Promise.resolve('search ran') },
    }))
    expect(installLimit()).toBeDefined()

    const result = await call('glob', { pattern: '**/*.txt', path: linked })

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/workspace it was granted/u)
    expect(calls).toEqual([])
  })

  it('refuses a permitted name the child tries to register for itself', () => {
    installLimit()
    const marker = join(outside, 'child-local-read-ran.txt')
    // The host's confined read holds the name in this child's own layer, so a child cannot put a
    // different definition under it — its own `read` is refused at registration, not at dispatch.
    expect(() => scope.ctx.tools.register(defineTool({
      name: 'read',
      description: 'a child-local read',
      parameters: { file_path: { type: 'string', required: true, description: 'path to read' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => {
        writeFileSync(marker, 'the child-local definition ran\n')
        return Promise.resolve('the child-local definition ran')
      },
    }))).toThrow(/already registered/u)
    expect(existsSync(marker)).toBe(false)
  })

  it('sandboxes a viewer-started turn while its layer is mounted', async () => {
    // A shared Session: a viewer-started turn reads only inside the granted workspace and can use nothing
    // this host did not install. Removing the layer is what restores the Session's own tools.
    const key = standInAgent(SessionId('session-shared-live'), root)
    let sharedScope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { sharedScope = createScope(inner, key) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    const shared = Object.assign(key, { ctx: sharedScope.ctx })
    const searchCalls: unknown[] = []
    for (const name of ['glob', 'grep']) {
      ctx.tools.register(defineTool({
        name,
        description: 'a deployment search fixture',
        parameters: {
          pattern: { type: 'string', required: true },
          path: { type: 'string' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (args) => { searchCalls.push({ name, args }); return Promise.resolve('search ran') },
      }))
    }
    const presented: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'present',
      description: 'a deployment delivery fixture',
      parameters: {
        files: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: { path: { type: 'string', required: true }, description: { type: 'string' } },
          },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { presented.push(args); return Promise.resolve('present ran') },
    }))
    const todos: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'todo_write',
      description: 'a deployment todo fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { todos.push(args); return Promise.resolve('todo ran') },
    }))
    ctx.tools.register(defineTool({
      name: 'danger',
      description: 'a capability the sandbox does not install',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ran'),
    }))
    const access = installSourceSessionAccess({
      sessionId: 'session-shared-live',
      context: sharedScope.ctx,
      scope: shared,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: shared.session.id }),
      fs: ctx.fs,
      tools: ctx.tools,
      describe: describeTool,
      write: { mayWrite: () => true },
      confinedExecution: () => true,
    })
    expect(access.readConfined).toBe(true)
    const run = (name: string, args: unknown) => executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId(`shared-${name}`),
      name,
      arguments: args,
      agent: shared,
    })
    const outsideFile = join(outside, 'secret.txt')

    // A viewer-started turn may run nothing this installation did not replace.
    const danger = await run('danger', {})
    expect(danger.isError).toBe(true)
    expect(text(danger)).toMatch(/may not use danger/u)
    expect((await run('read', { file_path: join(root, 'inside.ts') })).isError).toBe(false)
    const readOutside = await run('read', { file_path: outsideFile })
    expect(readOutside.isError).toBe(true)
    expect(text(readOutside)).toMatch(/not inside the workspace this session was granted/u)
    expect(text(readOutside)).not.toContain('owner-only')
    const escape = join(dirname(root), 'shared-escape.txt')
    expect((await run('write', { file_path: escape, content: 'no\n' })).isError).toBe(true)
    expect(existsSync(escape)).toBe(false)
    // This Session's layer is write-capable, so the bounded edit runs and stays inside the grant.
    const edited = await run('edit', {
      file_path: join(root, 'inside.ts'), old_string: 'export const inside = 1', new_string: 'export const inside = 2',
    })
    expect(edited.isError).toBe(false)
    expect(readFileSync(join(root, 'inside.ts'), 'utf8')).toBe('export const inside = 2\n')
    const outsideEdit = await run('edit', {
      file_path: outsideFile, old_string: 'owner-only', new_string: 'changed',
    })
    expect(outsideEdit.isError).toBe(true)
    expect(readFileSync(outsideFile, 'utf8')).toBe('owner-only\n')

    // The read surface is the shared surface: search, delivery, and the no-effect tools run, and each
    // declared path is resolved before the tool sees it.
    const canonicalRoot = ctx.fs.processPath(await ctx.fs.resolve(root))
    expect((await run('glob', { pattern: '**/*.ts' })).isError).toBe(false)
    expect(searchCalls.at(-1)).toEqual({ name: 'glob', args: { pattern: '**/*.ts', path: canonicalRoot } })
    expect((await run('grep', { pattern: 'inside', path: root })).isError).toBe(false)
    expect(searchCalls.at(-1)).toEqual({ name: 'grep', args: { pattern: 'inside', path: canonicalRoot } })
    const searchedOutside = await run('grep', { pattern: 'secret', path: outside })
    expect(searchedOutside.isError).toBe(true)
    expect(text(searchedOutside)).toMatch(/not inside the workspace this session was granted/u)
    expect((await run('present', {
      files: [{ path: join(root, 'inside.ts'), description: 'inside' }],
    })).isError).toBe(false)
    expect(presented.at(-1)).toEqual({
      files: [{ path: ctx.fs.processPath(await ctx.fs.resolve(join(root, 'inside.ts'))), description: 'inside' }],
    })
    expect((await run('present', { files: [{ path: outsideFile }] })).isError).toBe(true)
    expect((await run('todo_write', { todos: [] })).isError).toBe(false)
    expect(todos.at(-1)).toEqual({ todos: [] })

    // With no layer mounted the Session keeps its own tools again.
    access.dispose()
    expect((await run('danger', {})).isError).toBe(false)
    expect((await run('read', { file_path: outsideFile })).isError).toBe(false)
    expect(text(await run('read', { file_path: outsideFile }))).toContain('owner-only')
    expect((await run('grep', { pattern: 'secret', path: outside })).isError).toBe(false)
  })

  it('leaves an owner-started turn on the deployment’s own tools', async () => {
    // The layer belongs to the Session, but the share bounds only the turns a viewer starts: the owner
    // keeps the deployment's shell and its unbounded filesystem tools while every share is active.
    const key = standInAgent(SessionId('session-owner-turn'), root)
    let sharedScope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { sharedScope = createScope(inner, key) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    const shared = Object.assign(key, { ctx: sharedScope.ctx })
    let viewerTurn = false
    const bashCalls: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'a deployment shell fixture',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => {
        bashCalls.push(args)
        return Promise.resolve('bash ran')
      },
    }))
    const access = installSourceSessionAccess({
      sessionId: 'session-owner-turn',
      context: sharedScope.ctx,
      scope: shared,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: shared.session.id }),
      fs: ctx.fs,
      tools: ctx.tools,
      describe: describeTool,
      write: { mayWrite: () => true },
      confinedExecution: () => viewerTurn,
    })
    expect(access.readConfined).toBe(true)
    let calls = 0
    const run = (name: string, args: unknown) => executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId(`owner-${String(++calls)}`),
      name,
      arguments: args,
      agent: shared,
    })
    const outsideFile = join(outside, 'secret.txt')

    // The owner's turn runs the deployment's toolchain: the shell runs, and the native filesystem tools
    // are not held to the granted root.
    expect((await run('bash', { command: 'echo hi' })).isError).toBe(false)
    expect(text(await run('bash', { command: 'echo hi' }))).toContain('bash ran')
    expect(text(await run('read', { file_path: outsideFile }))).toContain('owner-only')
    const ownerWrite = join(outside, 'owner-write.txt')
    expect((await run('write', { file_path: ownerWrite, content: 'owner\n' })).isError).toBe(false)
    expect(readFileSync(ownerWrite, 'utf8')).toBe('owner\n')
    // The native edit replacement is a pass-through for an owner turn too.
    const ownerEdit = join(outside, 'owner-edit.txt')
    writeFileSync(ownerEdit, 'owner-only\n')
    expect((await run('read', { file_path: ownerEdit })).isError).toBe(false)
    expect((await run('edit', {
      file_path: ownerEdit, old_string: 'owner-only', new_string: 'owner-edited',
    })).isError).toBe(false)
    expect(readFileSync(ownerEdit, 'utf8')).toBe('owner-edited\n')

    // A viewer-started turn of the same mounted layer is confined again: the shell is refused and reads
    // stop at the granted root.
    viewerTurn = true
    const bash = await run('bash', { command: 'echo hi' })
    expect(bash.isError).toBe(true)
    expect(text(bash)).toMatch(/may not use bash/u)
    const outsideRead = await run('read', { file_path: outsideFile })
    expect(outsideRead.isError).toBe(true)
    expect(text(outsideRead)).not.toContain('owner-only')
    const viewerWrite = join(outside, 'viewer-write.txt')
    expect((await run('write', { file_path: viewerWrite, content: 'no\n' })).isError).toBe(true)
    expect(existsSync(viewerWrite)).toBe(false)

    // Disposing the layer restores the Session's own tools whether or not a viewer turn is recorded.
    access.dispose()
    expect((await run('bash', { command: 'echo hi' })).isError).toBe(false)
    expect(text(await run('read', { file_path: outsideFile }))).toContain('owner-only')
  })

  it('refuses write and edit on a view-tier shared Session', async () => {
    const key = standInAgent(SessionId('session-view-live'), root)
    let viewScope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { viewScope = createScope(inner, key) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    const view = Object.assign(key, { ctx: viewScope.ctx })
    const access = installSourceSessionAccess({
      sessionId: 'session-view-live',
      context: viewScope.ctx,
      scope: view,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: view.session.id }),
      fs: ctx.fs,
      tools: ctx.tools,
      describe: describeTool,
    })
    expect(access).toMatchObject({ readConfined: true, writeConfined: false })
    const run = (name: string, args: unknown) => executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId(`view-${name}`),
      name,
      arguments: args,
      agent: view,
    })

    expect((await run('read', { file_path: join(root, 'inside.ts') })).isError).toBe(false)
    const written = await run('write', { file_path: join(root, 'view-write.txt'), content: 'no\n' })
    expect(written.isError).toBe(true)
    expect(text(written)).toMatch(/may not use write/u)
    expect(existsSync(join(root, 'view-write.txt'))).toBe(false)
    const edited = await run('edit', {
      file_path: join(root, 'inside.ts'), old_string: 'export const inside = 1', new_string: 'export const inside = 2',
    })
    expect(edited.isError).toBe(true)
    expect(text(edited)).toMatch(/may not use edit/u)
    expect(readFileSync(join(root, 'inside.ts'), 'utf8')).toBe('export const inside = 1\n')
    access.dispose()
  })

  it('writes inside the granted workspace and refuses everything outside it', async () => {
    // A write-capable scope: the host installs its own bounded write, so the real write tool writes the
    // file the grant contains and nothing else.
    const writer = { id: 'child-writer', session: { header: { cwd: root } } }
    let writerScope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { writerScope = createScope(inner, writer) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    await forks.record({
      childSessionId: 'child-writer',
      shareId: 'share-1',
      sourceSessionId: 'session-1',
      boundary: 3,
      creator: { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' },
      createdAt: '2026-09-12T00:00:00.000Z',
    })
    const dispose = installForkEnforcement({
      childSessionId: 'child-writer',
      childContext: writerScope.ctx,
      childScope: writer,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: SessionId(writer.id) }),
      fs: ctx.fs,
      tools: ctx.tools,
      forks,
      describe: describeTool,
      write: true,
    })
    expect(dispose).toBeDefined()
    const call = (name: string, args: unknown) => executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId(`write-${name}`),
      name,
      arguments: args,
      agent: writer as never,
    })

    const inside = await call('write', { file_path: join(root, 'written.txt'), content: 'bounded\n' })
    expect(inside.isError).toBe(false)
    expect(readFileSync(join(root, 'written.txt'), 'utf8')).toBe('bounded\n')

    // The same tool, named outside the grant: refused, and the outside tree gains nothing.
    const outside = await call('write', { file_path: join(dirname(root), '..', 'outside-here.txt'), content: 'nope\n' })
    expect(outside.isError).toBe(true)
    expect(existsSync(join(dirname(root), '..', 'outside-here.txt'))).toBe(false)
    dispose?.()
  })

  it('edits inside the granted workspace through the bounded edit and refuses everything outside it', async () => {
    await ctx.plugin(FsObservationPolicy)
    const writer = { id: 'child-editor', session: { header: { cwd: root } } }
    let writerScope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { writerScope = createScope(inner, writer) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    await forks.record({
      childSessionId: 'child-editor',
      shareId: 'share-1',
      sourceSessionId: 'session-1',
      boundary: 3,
      creator: viewer,
      createdAt: '2026-09-12T00:00:00.000Z',
    })
    const dispose = installForkEnforcement({
      childSessionId: 'child-editor',
      childContext: writerScope.ctx,
      childScope: writer,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: SessionId('child-editor') }),
      fs: ctx.fs,
      tools: ctx.tools,
      forks,
      describe: describeTool,
      write: true,
    })
    expect(dispose).toBeDefined()
    const path = join(root, 'inside.ts')
    const run = (name: string, args: unknown) => executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId(`edit-${name}`),
      name,
      arguments: args,
      agent: writer as never,
    })

    // The observation policy still asks for the read before the edit.
    const unread = await run('edit', { file_path: path, old_string: 'export const inside = 1', new_string: 'export const inside = 2' })
    expect(unread.isError).toBe(true)
    expect((await run('read', { file_path: path })).isError).toBe(false)

    const edited = await run('edit', {
      file_path: path, old_string: 'export const inside = 1', new_string: 'export const inside = 2',
    })
    expect(edited.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('export const inside = 2\n')

    // The same tool naming a file outside the grant is refused, and that file keeps its content.
    const outsidePath = join(outside, 'secret.txt')
    const escaped = await run('edit', {
      file_path: outsidePath, old_string: 'owner-only', new_string: 'changed',
    })
    expect(escaped.isError).toBe(true)
    expect(text(escaped)).toMatch(/workspace it was granted/u)
    expect(readFileSync(outsidePath, 'utf8')).toBe('owner-only\n')
    dispose?.()
  })

  it('shadows the read a preset scope registered when the child sits beneath it', async () => {
    installLimit()
    // A product profile registers its filesystem tools in a preset/ancestor scope, not globally: the
    // child sits beneath that scope, and the host's confined read must shadow it there.
    const shippedRead = ctx.tools.get('read')
    if (shippedRead === undefined) throw new Error('the deployment registers no read tool')
    let parent!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { parent = createScope(inner, { id: 'parent-scope' }) },
      { inject: ['tools'] },
    ))
    parent.ctx.tools.register(shippedRead)
    const layeredChild = { id: 'child-2', session: { header: { cwd: root } } }
    let underParent!: Scope
    await parent.ctx.plugin(Object.assign(
      (inner: Context) => { underParent = createScope(inner, layeredChild) },
      { inject: ['tools', 'fs', 'systemPrompt'] },
    ))
    await forks.record({
      childSessionId: 'child-2',
      shareId: 'share-1',
      sourceSessionId: 'session-1',
      boundary: 3,
      creator: { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' },
      createdAt: '2026-09-12T00:00:00.000Z',
    })
    const dispose = installForkEnforcement({
      childSessionId: 'child-2',
      childContext: underParent.ctx,
      childScope: layeredChild,
      grantedRoot: granted,
      cwd: root,
      resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: SessionId(layeredChild.id) }),
      fs: ctx.fs,
      tools: ctx.tools,
      forks,
      describe: describeTool,
    })

    expect(dispose).toBeDefined()
    const layered = await executeOneTool(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('call-layered'),
      name: 'read',
      arguments: { file_path: join(root, 'inside.ts') },
      agent: layeredChild as never,
    })
    // The child's inherited definition is confined, and the name is held: a child-local read is refused.
    expect(layered.isError).toBe(false)
    expect(text(layered)).toContain('export const inside = 1')
    expect(() => underParent.ctx.tools.register(shippedRead)).toThrow(/already registered/u)
    dispose?.()
  })

  it('keeps the authorized root when the directory above the grant is replaced', async () => {
    installLimit()
    // The limit captured the root it was installed with. Replacing the directory above that root with
    // a symlink to a tree of the same shape must not re-grant a new root: the read refuses, and the
    // other tree's content never appears.
    const tree = dirname(dirname(root))
    const other = join(tree, 'outside-granted')
    mkdirSync(join(other, 'leaf'), { recursive: true })
    writeFileSync(join(other, 'leaf', 'inside.ts'), 'OUTSIDE-ROOT\n')
    rmSync(join(tree, 'granted'), { recursive: true, force: true })
    symlinkSync(other, join(tree, 'granted'))

    const result = await call('read', { file_path: join(root, 'inside.ts') })

    expect(text(result)).not.toContain('OUTSIDE-ROOT')
    expect(result.isError).toBe(true)
  })

  it('keeps the authorized target when a link inside the grant is repointed before dispatch', async () => {
    installLimit()
    // A name that resolves inside the grant when the pre-execute check runs.
    const link = join(root, 'link-inside.txt')
    symlinkSync(join(root, 'inside.ts'), link)
    const swap = ctx.on('tools/pre-execute', (_exec, next) => {
      // Registered after the limit, so it runs after the grant check and before dispatch: the escape a
      // path-only check cannot see.
      rmSync(link, { force: true })
      symlinkSync(join(outside, 'secret.txt'), link)
      return next()
    })
    try {
      const result = await call('read', { file_path: link })
      // Either answer is safe; reading the owner's file is not. The confined read refuses because it
      // resolves and checks the target inside the call, after the pre-execute verdict.
      expect(text(result)).not.toContain('owner-only')
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/workspace it was granted/u)
    } finally {
      swap()
    }
  })

  it('opens the prompt and cancel gate only while this child’s guard is live', async () => {
    // The host answers both `session/prompt` and `session/cancel` from this one decision.
    expect(forks.allowsPrompt(childSessionId, viewer)).toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })

    const dispose = installLimit()
    expect(forks.allowsPrompt(childSessionId, viewer)).toEqual({ ok: true })

    dispose?.()
    expect(forks.allowsPrompt(childSessionId, viewer)).toMatchObject({ ok: false, code: 'fork-ceiling-uninstalled' })
    const afterRelease = await call('read', { file_path: join(root, 'inside.ts') })
    expect(afterRelease.isError).toBe(true)
    expect(text(afterRelease)).toMatch(/limits are not installed/u)
  })

  it('would read the repointed file if nothing confined what the tool opens', async () => {
    // Control for the repointed-path test above: the same swap under the same guard, but with the
    // deployment's read tool still holding the name and no check inside the tool itself. The escape is
    // real, so the refusal above is the fork-scoped read's doing rather than the pipeline's.
    const dispose = installChildEnforcement({
      childSessionId,
      ceiling: READ_ONLY_FORK_CEILING,
      guard: forkToolGuard({
        childOf: () => childSessionId,
        enforcementInstalled: id => forks.enforcementInstalled(id),
        toolIsTrusted: () => true,
        authorizeReadPath: () => true,
      }, () => forks.enforcedCeiling(childSessionId), describeTool),
      verdictSource: () => Promise.resolve(),
    }, {
      contextOf: () => scope.ctx,
      registerGuard: (context, guard) => context.tools.guard(guard),
      registerVerdictSource: (context, source) => context.on(
        'tools/pre-execute',
        async (exec, next) => { await source(exec); return next() },
      ),
      recordEnforcement: (id, ceiling) => forks.installEnforcement(id, ceiling),
      releaseEnforcement: (id) => { forks.releaseEnforcement(id) },
    })
    expect(dispose).toBeDefined()
    const link = join(root, 'link-control.txt')
    symlinkSync(join(root, 'inside.ts'), link)
    const swap = ctx.on('tools/pre-execute', (_exec, next) => {
      rmSync(link, { force: true })
      symlinkSync(join(outside, 'secret.txt'), link)
      return next()
    })
    try {
      const result = await call('read', { file_path: link })
      expect(text(result)).toContain('owner-only')
    } finally {
      swap()
      dispose?.()
    }
  })
})
