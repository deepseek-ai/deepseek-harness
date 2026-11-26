/** Real Loader and AgentLoop composition; only the model and the GitHub and GitLab CLIs are fixtures. */

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
import * as ForgeGitLab from '@deepseek-ai/dsh-forge-gitlab'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, LlmAdapter, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { pluginRecordOf, type SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import * as PtcToolRegistry from '@deepseek-ai/dsh-tool-registry-ptc'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { GH_COMMANDS } from '@deepseek-ai/dsh-experimental-forge-github/src/commands.ts'
import { GLAB_COMMANDS } from '@deepseek-ai/dsh-forge-gitlab/src/commands.ts'
import { compileRules } from '../src/commands.ts'
import ForgeSessionService from '../src/index.ts'
import type { SessionChangeRequest, SessionChangeRequestsListener } from '../src/index.ts'
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'

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
    else if (fields === 'url') {
      const url = 'https://' + (process.env.FORGE_TEST_HOST || 'github.com') + '/octo/demo/pull/9'
      process.stdout.write(args.includes('--jq') ? url + '\n' : JSON.stringify({ url }))
    } else process.stdout.write(JSON.stringify({ number: 9, title: 'Change 9', body: 'Stacked on https://github.com/octo/demo/pull/6' }))
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
  id: 'pull-' + number,
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
  baseRefOid: 'e'.repeat(40),
  additions: 1,
  deletions: 0,
  mergeable: 'MERGEABLE',
  mergeStateStatus: number === 7 ? 'BLOCKED' : 'CLEAN',
  reviewDecision: null,
  viewerCanUpdateBranch: false,
  canBeRebased: false,
  viewerCanEnableAutoMerge: false,
  viewerCanDisableAutoMerge: false,
  isMergeQueueEnabled: false,
  autoMergeRequest: null,
  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  reviewRequests: { totalCount: 0, nodes: [] },
  latestReviews: { totalCount: 0, nodes: [] },
  latestOpinionatedReviews: { totalCount: 0, nodes: [] },
  closingIssuesReferences: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: {
    id: 'rollup-' + number, state: number === 7 ? 'PENDING' : 'SUCCESS',
    contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      __typename: 'CheckRun', id: 'check-1', databaseId: 1, name: 'test', status: number === 7 ? 'IN_PROGRESS' : 'COMPLETED', conclusion: number === 7 ? null : 'SUCCESS',
      detailsUrl: null, startedAt: null, completedAt: null, checkSuite: { app: { id: 'actions' }, workflowRun: { databaseId: 1, event: 'pull_request', workflow: { id: 'ci', name: 'ci' } } },
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

/**
 * GitLab CLI fixture: \`mr create\` prints merge request 5 on gitlab.example.test; \`mr view N\` prints its title,
 * or its web URL for \`--jq .web_url\`; \`api graphql\` answers status queries with an open merge request whose head
 * pipeline passed, and other \`api\` paths with an empty list.
 */
const FAKE_GLAB = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(new URL('./glab.log', import.meta.url), JSON.stringify(args) + '\n')
if (args[0] === 'mr' && args[1] === 'create') {
  process.stdout.write('Creating merge request for feat into main in group/app\n\n!5 Change 5 (feat)\n https://gitlab.example.test/group/app/-/merge_requests/5\n')
  process.exit(0)
}
if (args[0] === 'mr' && args[1] === 'view') {
  const web = args[args.indexOf('--jq') + 1] === '.web_url'
  process.stdout.write((web ? 'https://gitlab.example.test/group/app/-/merge_requests/' : 'Change ') + args[2] + '\n')
  process.exit(0)
}
const path = args.filter((arg, index) => !arg.startsWith('-') && !['--hostname', '--input', '-H'].includes(args[index - 1])).at(-1)
if (path !== 'graphql') { process.stdout.write('[]'); process.exit(0) }
const { variables } = JSON.parse(readFileSync(0, 'utf8'))
const data = {}
for (const [name, iid] of Object.entries(variables)) {
  if (!/^i\d+$/.test(name)) continue
  data['m' + name.slice(1)] = { mergeRequestsFfOnlyEnabled: false, mergeRequest: {
    iid, title: 'Change ' + iid, webUrl: 'https://gitlab.example.test/group/app/-/merge_requests/' + iid, state: 'opened', draft: false,
    updatedAt: '2026-11-10T00:00:00Z', closedAt: null, mergedAt: null, author: { username: 'octo' }, sourceBranch: 'feat', targetBranch: 'main',
    diffRefs: { baseSha: 'e'.repeat(40), headSha: 'a'.repeat(40) }, diffStatsSummary: { additions: 1, deletions: 0 },
    detailedMergeStatus: 'MERGEABLE', mergeStatusEnum: 'CAN_BE_MERGED', conflicts: false, divergedFromTargetBranch: false, rebaseInProgress: false,
    squash: false, squashOnMerge: false, squashReadOnly: false, approved: false, resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0,
    userPermissions: { canMerge: true, pushToSourceBranch: true, updateMergeRequest: true },
    autoMergeEnabled: false, availableAutoMergeStrategies: [], mergeUser: null,
    approvedBy: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewers: { pageInfo: { hasNextPage: false }, nodes: [] },
    headPipeline: { id: 'gid://gitlab/Ci::Pipeline/1', status: 'SUCCESS', userPermissions: { updatePipeline: true },
      jobs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { name: 'test', status: 'SUCCESS', allowFailure: false, stage: { name: 'test' }, webPath: '/group/app/-/jobs/1', startedAt: null, finishedAt: null },
    ] } },
  } }
}
process.stdout.write(JSON.stringify({ data }))
`

/** `git push` fixture printing the refs a new branch push reports. */
const FAKE_GIT = `#!/bin/sh
printf 'To github.com:octo/demo.git\\n * [new branch]      feat -> feat\\n' >&2
`

/**
 * Deadline of one forge-session discovery or reference lookup in this composition. Lookups run after the tool result
 * that starts them, often past the end of the turn, and one that exceeds this deadline fails without a binding, so
 * waits for the bindings lookups record take the same bound.
 */
const LOOKUP_TIMEOUT_MS = 20_000

/** One scripted model step: the tool call it makes, or the final text when undefined. */
type ScriptedCall = Omit<ToolCallBlock, 'type' | 'id'> | undefined

/** A `bash` call running `command`. */
function bashCall(command: string): ScriptedCall {
  return { name: 'bash', arguments: JSON.stringify({ command, description: 'Run the scripted command' }) }
}

/** A PTC `run_code` call whose TypeScript program runs `commands` through the `bash` binding in order. */
function programCall(commands: readonly string[]): ScriptedCall {
  const code = `for (const command of ${JSON.stringify(commands)}) await tools.bash({ command, description: 'Run the scripted command' })`
  return { name: 'run_code', arguments: JSON.stringify({ code, description: 'Run the scripted commands' }) }
}

class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly calls: readonly ScriptedCall[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const scripted = this.calls[this.requests.length - 1]
    if (scripted !== undefined) {
      const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(`shell-${this.requests.length}`), ...scripted }
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

/** Plugins that replace the native executor in PTC mode, in load order. */
const PTC_MODULES = [
  ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
  ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
  ['@deepseek-ai/dsh-ptc-runtime-node', NodeRuntime],
  ['@deepseek-ai/dsh-tool-registry-ptc', PtcToolRegistry],
] as const

/**
 * Boot the composition through a test-only cordis.yml. `ptc` replaces the native executor with the PTC executor,
 * the Node program runtime, and the sandbox services that runtime requires.
 */
async function load(mode: 'native' | 'ptc' = 'native') {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-forge-session-loader-')))
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(root, 'fake-gh.mjs'), FAKE_GH)
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'fake-gh.mjs'))} "$@"\n`)
  await writeFile(join(bin, 'git'), FAKE_GIT)
  await writeFile(join(root, 'fake-glab.mjs'), FAKE_GLAB)
  await writeFile(join(bin, 'glab'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'fake-glab.mjs'))} "$@"\n`)
  await chmod(join(bin, 'glab'), 0o755)
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
    ...mode === 'native' ? [['@deepseek-ai/dsh-tool-registry-native', NativeToolRegistry] as const] : PTC_MODULES,
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-shell-env', ShellEnv],
    ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
    ['@deepseek-ai/dsh-tool-bash', ToolBash],
    ['@deepseek-ai/dsh-experimental-forge', ForgeService],
    ['@deepseek-ai/dsh-experimental-forge-github', ForgeGitHub],
    ['@deepseek-ai/dsh-forge-gitlab', ForgeGitLab],
    ['@deepseek-ai/dsh-experimental-forge-session', ForgeSessionService],
  ])
  const configs: Record<string, readonly string[]> = {
    '@deepseek-ai/dsh-agent-loop': ['agents: []'],
    '@deepseek-ai/dsh-shell-env': [`dshHome: ${JSON.stringify(join(root, 'dsh-home'))}`],
    '@deepseek-ai/dsh-sandbox-policy': ['mode: danger-full-access'],
    '@deepseek-ai/dsh-bash-local': ['timeoutMs: 20000'],
    '@deepseek-ai/dsh-experimental-forge': ['activeIntervalMs: 600000', 'idleIntervalMs: 600000'],
    '@deepseek-ai/dsh-experimental-forge-github': [`ghCommand: ${JSON.stringify(join(bin, 'gh'))}`],
    '@deepseek-ai/dsh-forge-gitlab': [`glabCommand: ${JSON.stringify(join(bin, 'glab'))}`, 'hosts: [gitlab.example.test]'],
    '@deepseek-ai/dsh-experimental-forge-session': [`discoveryTimeoutMs: ${LOOKUP_TIMEOUT_MS}`],
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
  const handle = await ctx.agents.create({ sessionId: brandString<SessionId>('reference-observer') })
  const controller = new AbortController()
  const exec: ToolExecution = {
    name: 'bash', agent: handle.agent,
    callId: brandString<ToolCallId>('reference'), rootCallId: brandString<ToolCallId>('reference'), token: Symbol('reference') as ToolExecutionToken,
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

/** Push `feat`, create PR 8, and view PR 9 by number without its URL in the output. */
function scriptedCommands(path: string): string[] {
  return [
    `${path} git push -u origin feat`,
    `${path} gh pr create --fill --head other`,
    `${path} gh pr view 9 --repo octo/demo --json number,title,body 2>&1 | head -200`,
  ]
}

/** Run one user turn of a scripted model in a new Agent and wait until the Agent is idle. */
async function runTurn(ctx: Context, root: string, sessionId: string, calls: readonly ScriptedCall[]) {
  const model = new ScriptedModel(calls)
  ctx.llm.registerAdapter(['fixture'], model)
  const agent = await ctx.agentLoop.create(brandString<SessionId>(sessionId), { provider: 'fixture', model: 'fixture' }, { cwd: root })
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Push feat, open a pull request, and view PR 9.' }], source: { kind: 'user' } }))
  await idle.promise
  stop()
  return { agent, model }
}

/** Arguments of every fake `gh` invocation in call order. */
async function ghCalls(root: string): Promise<string[][]> {
  return (await readFile(join(root, 'gh.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
}

function byUrl(entries: readonly SessionChangeRequest[]): SessionChangeRequest[] {
  return [...entries].sort((left, right) => left.url.localeCompare(right.url))
}

/** Expect the push to discover PR 7, the create to bind PR 8, and the numbered view to resolve PR 9 through `gh`. */
async function expectScriptedBindings(ctx: Context, session: Session, root: string): Promise<void> {
  const records = () => session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record === undefined ? [] : [record.data]
  })
  // The push's discovery and the view's reference lookup each run a `gh` process; a program's lookups start only once
  // its root call settles.
  await vi.waitFor(() => { expect(records()).toEqual(expect.arrayContaining([
    { action: 'discover', url: 'https://github.com/octo/demo/pull/7' },
    { action: 'reference', url: 'https://github.com/octo/demo/pull/9' },
  ])) }, { timeout: LOOKUP_TIMEOUT_MS })
  const github = (number: number) => ({ repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number })
  expect(byUrl(ctx.forgeSession.changeRequests(session))).toEqual([
    { url: 'https://github.com/octo/demo/pull/7', origin: 'discovered', ref: github(7), update: null },
    { url: 'https://github.com/octo/demo/pull/8', origin: 'created', ref: github(8), update: null },
    { url: 'https://github.com/octo/demo/pull/9', origin: 'referenced', ref: github(9), update: null },
  ])
  expect(await ghCalls(root)).toContainEqual(['pr', 'view', '9', '--repo', 'octo/demo', '--json', 'url', '--jq', '.url'])
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
      if (String(message).includes('change request reference lookup failed')) reported.resolve(undefined)
    })
    f.ctx.emit('tools/result', { ...f.exec, arguments: { command: `${f.path} FORGE_TEST_MODE=${mode} gh pr view 9 -R octo/demo --json number` } }, f.result)
    await reported.promise
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('change request reference lookup failed'))
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
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('change request reference lookup failed'))
  })

  it('skips calls without a completed foreground result, explicit repository, or live caller', async () => {
    const f = await observerFixture()
    const emit = (exec: ToolExecution, result: ToolExecutionResult = f.result) => { f.ctx.emit('tools/result', exec, result) }
    emit({ ...f.exec, name: 'pwsh' })
    const { agent: _agent, ...withoutAgent } = f.exec
    emit(withoutAgent)
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
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('change request reference lookup failed'))
    expect(f.records()).toEqual([])
  })

  it('binds the pull requests that bash pushes discover, creates, and views, and polls them through the GitHub provider', async () => {
    const { ctx, path, root } = await load()
    const { agent, model } = await runTurn(ctx, root, 'forge-session-loader', scriptedCommands(path).map(bashCall))

    expect(model.requests).toHaveLength(4)
    await expectScriptedBindings(ctx, agent.session, root)
    const lookups = await ghCalls(root)
    expect(lookups.find(args => args.includes('branch=feat'))).toEqual(expect.arrayContaining(['--hostname', 'github.com', 'owner=octo', 'name=demo']))

    const listener = vi.fn<SessionChangeRequestsListener>()
    ctx.forgeSession.watch(agent.session, listener)
    await vi.waitFor(() => { expect(byUrl(listener.mock.lastCall?.[0] ?? []).map(entry => entry.update !== null && 'snapshot' in entry.update
      ? [entry.update.snapshot.title, entry.update.snapshot.checksRollup]
      : null)).toEqual([['Change 7', 'pending'], ['Change 8', 'success'], ['Change 9', 'success']]) })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-forge-session')
    const row = ctx.sessionProjections.checkpoint(agent.session).forgeChangeRequests
    await entry?.fiber?.dispose()
    expect(ctx.sessionProjections.checkpoint(agent.session)).toHaveProperty('forgeChangeRequests', row)
    expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('forgeChangeRequests')
  }, 60_000)

  it('binds the pull requests that shell calls inside a PTC program push, create, and view', async () => {
    const { ctx, path, root } = await load('ptc')
    const { agent, model } = await runTurn(ctx, root, 'forge-session-ptc', [programCall(scriptedCommands(path))])

    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    const events = agent.session.snapshotEvents()
    expect(events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])).toEqual(['run_code'])
    expect(events.flatMap(event => event.type === 'tool/ptc-dispatch' ? [[event.data.name, event.data.isError]] : [])).toEqual([
      ['bash', false], ['bash', false], ['bash', false],
    ])
    await expectScriptedBindings(ctx, agent.session, root)
  }, 60_000)

  it('folds with every provider rule once the composition starts, and keeps that state version through a shutdown and a restart', async () => {
    const version = compileRules([GH_COMMANDS, GLAB_COMMANDS]).version
    const started = async () => {
      const loaded = await load()
      // The providers register their rules after forge-session starts, which re-registers the projection once.
      await new Promise((resolve) => { setImmediate(resolve) })
      return loaded
    }
    const { ctx } = await started()
    const session = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(session).forgeChangeRequests?.ver).toBe(version)
    // Providers unload before forge-session at shutdown; the folded rules, and so the checkpointed version, stay.
    for (const entry of ctx.loader.entries()) {
      if (/forge-git(?:hub|lab)'?$/.test(entry.options.name)) await entry.fiber?.dispose()
    }
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(ctx.forge.changeRequestFromUrl('https://github.com/octo/demo/pull/1')).toBeUndefined()
    expect(ctx.sessionProjections.checkpoint(session).forgeChangeRequests?.ver).toBe(version)
    await ctx.fiber.dispose()
    context = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    const restarted = await started()
    expect(restarted.ctx.sessionProjections.checkpoint(restarted.ctx.sessions.create()).forgeChangeRequests?.ver).toBe(version)
  }, 60_000)

  it.each(['native', 'ptc'] as const)('binds the merge requests glab creates and views through the %s executor, and polls them through the GitLab provider', async (mode) => {
    const { ctx, path, root } = await load(mode)
    const commands = [
      `${path} glab mr create --fill --yes`,
      `${path} glab mr view 6 -R https://gitlab.example.test/group/app -F json --jq .title`,
      `${path} glab mr view 7 -R group/app -F json --jq .title`,
      `${path} glab api --hostname gitlab.example.test projects/group%2Fapp/merge_requests/8/changes`,
      `${path} glab api projects/group%2Fapp/merge_requests/9`,
    ]
    const { agent } = await runTurn(ctx, root, `forge-session-gitlab-${mode}`, mode === 'native' ? commands.map(bashCall) : [programCall(commands)])
    if (mode === 'ptc') {
      const events = agent.session.snapshotEvents()
      expect(events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])).toEqual(['run_code'])
      expect(events.flatMap(event => event.type === 'tool/ptc-dispatch' ? [[event.data.name, event.data.isError]] : [])).toEqual([
        ['bash', false], ['bash', false], ['bash', false], ['bash', false], ['bash', false],
      ])
    }

    const merge = (number: number) => ({
      url: `https://gitlab.example.test/group/app/-/merge_requests/${number}`,
      ref: { repository: { forge: 'gitlab', host: 'gitlab.example.test', owner: 'group', name: 'app' }, number },
    })
    // Two of the five are bound by shell lookups, and a program's lookups start only once its root call settles.
    await vi.waitFor(() => { expect(ctx.forgeSession.changeRequests(agent.session)).toHaveLength(5) }, { timeout: LOOKUP_TIMEOUT_MS })
    expect(byUrl(ctx.forgeSession.changeRequests(agent.session))).toEqual([5, 6, 7, 8, 9].map(number => ({
      ...merge(number), origin: number === 5 ? 'created' : 'referenced', update: null,
    })))
    const lookups = (await readFile(join(root, 'glab.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(lookups).toContainEqual(['mr', 'view', '7', '--repo', 'group/app', '--output', 'json', '--jq', '.web_url'])
    expect(lookups).toContainEqual(['mr', 'view', '9', '--repo', 'group/app', '--output', 'json', '--jq', '.web_url'])
    expect(lookups).not.toContainEqual(expect.arrayContaining(['6', '--repo']))
    await rm(join(root, 'glab.log'))
    for (const number of [6, 7, 8, 9]) ctx.forgeSession.dismiss(agent.session, merge(number).url)

    const url = 'https://gitlab.example.test/group/app/-/merge_requests/5'
    expect(ctx.forgeSession.changeRequests(agent.session)).toEqual([{
      url, origin: 'created', ref: { repository: { forge: 'gitlab', host: 'gitlab.example.test', owner: 'group', name: 'app' }, number: 5 }, update: null,
    }])
    const listener = vi.fn<SessionChangeRequestsListener>()
    ctx.forgeSession.watch(agent.session, listener)
    await vi.waitFor(() => { expect(listener.mock.lastCall?.[0].map(entry => entry.update !== null && 'snapshot' in entry.update
      ? [entry.update.snapshot.title, entry.update.snapshot.checksRollup, entry.update.snapshot.mergeMethods]
      : null)).toEqual([['Change 5', 'success', ['merge', 'squash']]]) })
    const calls = (await readFile(join(root, 'glab.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toContainEqual(['api', 'graphql', '--hostname', 'gitlab.example.test', '--input', '-', '-H', 'Content-Type: application/json'])
  }, 60_000)
})
