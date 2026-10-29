/** Real Loader and AgentLoop composition; only the model and the GitHub CLI are fixtures. */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import * as ForgeGitHub from '@deepseek-ai/dsh-experimental-forge-github'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import ForgeSessionService from '../src/index.ts'
import type { SessionChangeRequest, SessionChangeRequestsListener } from '../src/index.ts'
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/**
 * GitHub CLI fixture: `pr create` prints PR 8; `pr view` prints PR 9, whose description links PR 6;
 * `api graphql` answers the head lookup and snapshot queries.
 */
const FAKE_GH = String.raw`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(new URL('./gh.log', import.meta.url), JSON.stringify(args) + '\n')
const reply = (data) => { process.stdout.write(JSON.stringify({ data })); process.exit(0) }
if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('https://github.com/octo/demo/pull/8\n')
  process.stderr.write('\nCreating pull request for other into main in octo/demo\n\n')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  if (args.includes('--json')) {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'url' && process.env.FORGE_TEST_MODE === 'fail') process.exit(1)
    if (fields === 'url' && process.env.FORGE_TEST_MODE === 'invalid') { process.stdout.write('{}'); process.exit(0) }
    if (fields === 'url' && process.env.FORGE_TEST_MODE === 'wait') { setInterval(() => {}, 1000); }
    else process.stdout.write(JSON.stringify(fields === 'url'
      ? { url: 'https://' + (process.env.FORGE_TEST_HOST || 'github.com') + '/octo/demo/pull/9' }
      : { number: 9, title: 'Change 9', body: 'Stacked on https://github.com/octo/demo/pull/6' }))
    if (process.env.FORGE_TEST_MODE !== 'wait') process.exit(0)
    else await new Promise(() => {})
  }
  process.stdout.write('title:\tChange 9\nstate:\tOPEN\nurl:\thttps://github.com/octo/demo/pull/9\n--\nStacked on https://github.com/octo/demo/pull/6\n')
  process.exit(0)
}
if (args[0] !== 'api' || args[1] !== 'graphql') {
  process.stderr.write('unexpected gh invocation\n')
  process.exit(2)
}
const fields = Object.fromEntries(args.flatMap((arg, index) => args[index - 1] === '-f' ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : []))
if ('branch' in fields) {
  reply({ repository: { defaultBranchRef: { name: 'main' }, pullRequests: { nodes: fields.branch === 'feat' ? [{ number: 7, isCrossRepository: false }] : [] } } })
}
const node = (number) => ({
  number,
  url: 'https://github.com/octo/demo/pull/' + number,
  title: 'Change ' + number,
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2026-10-09T00:00:00Z',
  closedAt: null,
  author: { login: 'octo' },
  headRefName: number === 7 ? 'feat' : 'other',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  additions: 1,
  deletions: 0,
  mergeable: 'MERGEABLE',
  mergeStateStatus: number === 7 ? 'BLOCKED' : 'CLEAN',
  reviewDecision: null,
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: {
    id: 'rollup-' + number, state: number === 7 ? 'PENDING' : 'SUCCESS',
    contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      __typename: 'CheckRun', id: 'check-1', databaseId: 1, name: 'test', status: number === 7 ? 'IN_PROGRESS' : 'COMPLETED', conclusion: number === 7 ? null : 'SUCCESS',
      detailsUrl: null, startedAt: null, completedAt: null, checkSuite: { app: { id: 'actions' }, workflowRun: { event: 'pull_request', workflow: { id: 'ci', name: 'ci' } } },
    }] },
  } } }] },
})
const data = {}
let repository
for (const match of fields.query.matchAll(/(r\d+): repository\(|(p\d+): pullRequest\(number: (\d+)\)/g)) {
  if (match[1] !== undefined) data[repository = match[1]] = {}
  else data[repository][match[2]] = node(Number(match[3]))
}
reply(data)
`

/** `git push` fixture printing the refs a new branch push reports. */
const FAKE_GIT = `#!/bin/sh
printf 'To github.com:octo/demo.git\\n * [new branch]      feat -> feat\\n' >&2
`

class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly commands: readonly string[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const command = this.commands[this.requests.length - 1]
    if (command !== undefined) {
      const call = { type: 'tool-call' as const, id: ToolCallId(`shell-${this.requests.length}`), name: 'bash', arguments: JSON.stringify({ command, description: 'Run the scripted command' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Pushed and opened the pull request.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const suite = process.platform === 'win32' ? describe.skip : describe

async function load() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-forge-session-loader-')))
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(root, 'fake-gh.mjs'), FAKE_GH)
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'fake-gh.mjs'))} "$@"\n`)
  await writeFile(join(bin, 'git'), FAKE_GIT)
  await chmod(join(bin, 'gh'), 0o755)
  await chmod(join(bin, 'git'), 0o755)

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-shell-env', ShellEnv],
    ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
    ['@deepseek-ai/dsh-tool-bash', ToolBash],
    ['@deepseek-ai/dsh-experimental-forge', ForgeService],
    ['@deepseek-ai/dsh-experimental-forge-github', ForgeGitHub],
    ['@deepseek-ai/dsh-experimental-forge-session', ForgeSessionService],
  ])
  const configs: Record<string, readonly string[]> = {
    '@deepseek-ai/dsh-agent-loop': ['agents: []'],
    '@deepseek-ai/dsh-shell-env': [`dshHome: ${JSON.stringify(join(root, 'dsh-home'))}`],
    '@deepseek-ai/dsh-bash-local': ['timeoutMs: 20000'],
    '@deepseek-ai/dsh-experimental-forge': ['activeIntervalMs: 600000', 'idleIntervalMs: 600000'],
    '@deepseek-ai/dsh-experimental-forge-github': [`ghCommand: ${JSON.stringify(join(bin, 'gh'))}`],
    '@deepseek-ai/dsh-experimental-forge-session': ['discoveryTimeoutMs: 20000'],
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name in configs ? ['  config:', ...(configs[name] ?? []).map(line => `    ${line}`)] : [],
  ]).join('\n') + '\n')

  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()

  const path = `PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}`
  return { ctx, path, root }
}

async function observerFixture() {
  const { ctx, path, root } = await load()
  const handle = await ctx.agents.create({ sessionId: SessionId('reference-observer') })
  const controller = new AbortController()
  const exec: ToolExecution = {
    name: 'bash', agent: handle.agent,
    callId: ToolCallId('reference'), rootCallId: ToolCallId('reference'), token: Symbol('reference') as ToolExecutionToken,
    arguments: { command: `${path} gh pr view 9 -R octo/demo --json number` }, signal: controller.signal,
  }
  const result: ToolExecutionResult = {
    isError: false, content: [{ type: 'text', text: '{"number":9}' }],
    value: { kind: 'foreground', cwd: root, exitCode: 0, signal: null, timedOut: false, aborted: false },
  }
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-forge-session')!
  const records = () => handle.agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  const query = Promise.withResolvers<ShellExecution>()
  const recorded = Promise.withResolvers<undefined>()
  ctx.on('session/event', (_session, event) => {
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:forge-session/binding') recorded.resolve(undefined)
  })
  const execute = ctx.shell.execute.bind(ctx.shell)
  const executeSpy = vi.spyOn(ctx.shell, 'execute').mockImplementation(async (spec) => {
    const execution = await execute(spec)
    query.resolve(execution)
    return execution
  })
  return { ctx, path, exec, result, controller, entry, records, query, executeSpy, recorded }
}

suite('forge-session through a real cordis.yml Loader composition', () => {
  it('uses the CLI environment to resolve an Enterprise host and retains a dismissal after another lookup', async () => {
    const f = await observerFixture()
    const url = 'https://fake.test/octo/demo/pull/9'
    const emit = () => { f.ctx.emit('tools/result', {
      ...f.exec, arguments: { command: `${f.path} FORGE_TEST_HOST=fake.test gh pr view 9 -R octo/demo --json number` },
    }, f.result) }
    emit()
    await f.recorded.promise
    expect(f.records()).toEqual([{ action: 'reference', url }])
    f.ctx.forgeSession.dismiss(f.exec.agent!.session, url)
    emit()
    const spy = f.executeSpy
    expect(spy).toHaveBeenCalledTimes(2)
    const returned = spy.mock.results[1]
    if (returned?.type !== 'return') throw new Error('missing second lookup')
    const second = await returned.value
    await second.result()
    await f.entry.fiber?.dispose()
    expect(f.records()).toEqual([{ action: 'reference', url }, { action: 'dismiss', url }])
  })

  it.each(['fail', 'invalid'])('leaves bindings unchanged and logs a %s lookup', async (mode) => {
    const f = await observerFixture()
    const reported = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation((message) => {
      if (String(message).includes('PR reference lookup failed')) reported.resolve(undefined)
    })
    f.ctx.emit('tools/result', { ...f.exec, arguments: { command: `${f.path} FORGE_TEST_MODE=${mode} gh pr view 9 -R octo/demo --json number` } }, f.result)
    await reported.promise
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed'))
    expect(f.records()).toEqual([])
  })

  it.each(['caller', 'service'] as const)('waits for a running lookup to stop on %s cancellation', async (owner) => {
    const f = await observerFixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    f.ctx.emit('tools/result', { ...f.exec, arguments: { command: `${f.path} FORGE_TEST_MODE=wait gh pr view 9 -R octo/demo --json number` } }, f.result)
    const query = await f.query.promise
    if (owner === 'caller') f.controller.abort()
    await f.entry.fiber?.dispose()
    expect(query.status).not.toBe('running')
    expect((await query.result()).aborted).toBe(true)
    expect(f.records()).toEqual([])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed'))
  })

  it('skips calls without a completed foreground result, explicit repository, or live caller', async () => {
    const f = await observerFixture()
    const emit = (exec: ToolExecution, result: ToolExecutionResult = f.result) => { f.ctx.emit('tools/result', exec, result) }
    emit({ ...f.exec, name: 'pwsh' })
    const { agent: _agent, ...withoutAgent } = f.exec
    emit(withoutAgent)
    emit({ ...f.exec, parent: f.exec.token })
    emit(f.exec, { isError: true, error: { message: 'failed' }, content: [] })
    emit({ ...f.exec, arguments: {} })
    emit(f.exec, { isError: false, value: { kind: 'background' }, content: [] })
    emit({ ...f.exec, arguments: { command: 'gh pr view 9' } }, { ...f.result, content: [{ type: 'reasoning', text: 'thinking' }] })
    emit({ ...f.exec, arguments: { command: 'gh pr view 9 -R github.com/octo/demo' } })
    f.controller.abort()
    emit(f.exec)
    await f.entry.fiber?.dispose()
    expect(f.executeSpy).not.toHaveBeenCalled()
    expect(f.records()).toEqual([])
  })

  it('contains a shell preparation failure without changing the completed tool outcome', async () => {
    const f = await observerFixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    f.executeSpy.mockRejectedValue('unavailable')
    f.ctx.emit('tools/result', f.exec, f.result)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable')) })
    expect(f.records()).toEqual([])
    expect(f.result.isError).toBe(false)
  })

  it('joins a cancelled preparation failure without reporting it as a lookup failure', async () => {
    const f = await observerFixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<ShellExecution>()
    f.executeSpy.mockImplementation(() => { started.resolve(undefined); return pending.promise })
    f.ctx.emit('tools/result', f.exec, f.result)
    await started.promise
    f.controller.abort()
    pending.reject(new Error('cancelled during preparation'))
    await f.entry.fiber?.dispose()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('PR reference lookup failed'))
    expect(f.records()).toEqual([])
  })

  it('binds the pull requests that bash pushes discover, creates, and views, and polls them through the GitHub provider', async () => {
    const { ctx, path, root } = await load()
    const model = new ScriptedModel([
      `${path} git push -u origin feat`,
      `${path} gh pr create --fill --head other`,
      `${path} gh pr view 9 --repo octo/demo --json number,title,body 2>&1 | head -200`,
    ])
    ctx.llm.registerAdapter(['fixture'], model)
    const agent = await ctx.agentLoop.create(SessionId('forge-session-loader'), { provider: 'fixture', model: 'fixture' }, { cwd: root })
    const idle: PromiseWithResolvers<void> = Promise.withResolvers()
    const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') idle.resolve()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Push feat and open a pull request.' }], source: { kind: 'user' } }))
    await idle.promise
    stop()

    expect(model.requests).toHaveLength(4)
    const github = (number: number) => ({ repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number })
    const records = () => agent.session.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record === undefined ? [] : [record.data]
    })
    await vi.waitFor(() => { expect(records()).toEqual(expect.arrayContaining([
      { action: 'discover', url: 'https://github.com/octo/demo/pull/7' },
      { action: 'reference', url: 'https://github.com/octo/demo/pull/9' },
    ])) })
    const byUrl = (entries: readonly SessionChangeRequest[]) => [...entries].sort((left, right) => left.url.localeCompare(right.url))
    expect(byUrl(ctx.forgeSession.changeRequests(agent.session))).toEqual([
      { url: 'https://github.com/octo/demo/pull/7', origin: 'discovered', ref: github(7), update: null },
      { url: 'https://github.com/octo/demo/pull/8', origin: 'created', ref: github(8), update: null },
      { url: 'https://github.com/octo/demo/pull/9', origin: 'referenced', ref: github(9), update: null },
    ])
    const lookups = (await readFile(join(root, 'gh.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(lookups.find(args => args.includes('branch=feat'))).toEqual(expect.arrayContaining(['--hostname', 'github.com', 'owner=octo', 'name=demo']))
    expect(lookups).toContainEqual(['pr', 'view', '9', '--repo', 'octo/demo', '--json', 'url'])

    const listener = vi.fn<SessionChangeRequestsListener>()
    ctx.forgeSession.watch(agent.session, listener)
    await vi.waitFor(() => { expect(byUrl(listener.mock.lastCall?.[0] ?? []).map(entry => entry.update !== null && 'snapshot' in entry.update
      ? [entry.update.snapshot.title, entry.update.snapshot.checksRollup]
      : null)).toEqual([['Change 7', 'pending'], ['Change 8', 'success'], ['Change 9', 'success']]) })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-forge-session')
    await entry?.fiber?.dispose()
    expect(ctx.sessionProjections.checkpoint(agent.session)).not.toHaveProperty('forgeChangeRequests')
  }, 60_000)
})
