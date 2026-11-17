import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import * as ToolWorktree from '../src/index.ts'

const exec = promisify(execFile)
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('worktree tool through real Loader composition', () => {
  it('creates a checkout for a new name and enters an existing one, exits to the source checkout, reports canonical fields, and unregisters on disposal', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-loader-')))
    const repository = join(root, 'repo')
    await mkdir(repository)
    const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    })
    await git('init', '-b', 'main')
    await git('config', 'core.autocrlf', 'false')
    await writeFile(join(repository, 'file.txt'), 'committed\n')
    await git('add', 'file.txt')
    await git('-c', 'user.name=Worktree fixture', '-c', 'user.email=worktree@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial')
    const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],

      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
      ['@deepseek-ai/dsh-experimental-worktree', WorktreeService],
      ['@deepseek-ai/dsh-experimental-tool-worktree', ToolWorktree],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    const config = [...modules.keys()].flatMap(name => [
      `- name: 'cordis:${name}'`,
      ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
      ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
    ]).join('\n') + '\n'
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, config)
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const agent = await context.agentLoop.create(brandString<SessionId>('worktree-loader'), {}, { cwd: repository })
    const enter = (args: { name?: string; from?: string }, agentValue?: typeof agent) => executeToolFixture(context!, {
      name: 'enter_worktree', callId: brandString<ToolCallId>(`enter-${args.name ?? 'generated'}`), arguments: args,
      signal: new AbortController().signal,
      ...agentValue === undefined ? {} : { agent: agentValue },
    })
    const exit = (agentValue?: typeof agent) => executeToolFixture(context!, {
      name: 'exit_worktree', callId: brandString<ToolCallId>('exit'), arguments: {}, signal: new AbortController().signal,
      ...agentValue === undefined ? {} : { agent: agentValue },
    })
    const text = (result: Awaited<ReturnType<typeof enter>>) => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const path = join(repository, '.agents/worktrees/new-checkout')
    const creation = { path, branch: 'new-checkout', baseCommit, repositoryRoot: repository }

    // No worktree has the name, so the call creates one.
    const result = await enter({ name: 'new-checkout' }, agent)
    expect(result.isError).not.toBe(true)
    expect(result.value).toEqual({ ...creation, created: true })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    expect(context.workingDirectory.get(agent.session)).toBe(path)
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('committed\n')

    const failure = await enter({})
    expect(failure.isError).toBe(true)
    expect(text(failure)).toContain('requires a calling agent')
    expect(failure.isError && failure.error.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    // Inside the new worktree the name selects its own empty pool, and the branch of a nested worktree already exists.
    const nested = await enter({ name: 'new-checkout' }, agent)
    expect(nested.isError && nested.error.info).toEqual({ name: 'WorktreeError', code: 'WORKTREE_ALREADY_EXISTS' })
    // A forwarded `fetch` would make the runtime refuse `main`, which is not a remote-tracking branch.
    const undeclared = await executeToolFixture(context, {
      name: 'enter_worktree', callId: brandString<ToolCallId>('undeclared'), arguments: { from: 'main', fetch: true }, agent,
      signal: new AbortController().signal,
    })
    expect(undeclared.isError).not.toBe(true)
    expect(undeclared.value).toMatchObject({ baseCommit, repositoryRoot: path, created: true })
    // Leaving the generated worktree returns the Session to `new-checkout`.
    expect((await exit(agent)).value).toMatchObject({ baseCommit, repositoryRoot: path })
    expect(context.workingDirectory.get(agent.session)).toBe(path)
    expect(context.tools.get('enter_worktree')!.presentCall!({ name: 'named' })).toEqual({
      card: 'generic', title: 'enter_worktree', rawInput: { name: 'named' },
    })

    const left = await exit(agent)
    expect(left.isError).not.toBe(true)
    expect(left.value).toEqual(creation)
    expect(left.content).toEqual([{ type: 'text', text: JSON.stringify(creation) }])
    expect(context.workingDirectory.get(agent.session)).toBe(repository)
    const outside = await exit(agent)
    expect(outside.isError && outside.error.info).toEqual({ name: 'WorktreeError', code: 'WORKTREE_NOT_ENTERED' })
    expect(text(outside)).toContain('no recorded worktree contains the working directory')
    const agentless = await exit()
    expect(agentless.isError && agentless.error.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    expect(context.tools.get('exit_worktree')!.presentCall!({})).toEqual({ card: 'generic', title: 'exit_worktree', rawInput: {} })

    // The worktree now exists, so the same name enters it and creates nothing.
    const branches = (await git('branch', '--list')).stdout
    const entered = await enter({ name: 'new-checkout' }, agent)
    expect(entered.isError).not.toBe(true)
    expect(entered.value).toEqual({ path, branch: 'new-checkout', repositoryRoot: repository, created: false })
    expect(entered.content).toEqual([{ type: 'text', text: JSON.stringify(entered.value) }])
    expect(context.workingDirectory.get(agent.session)).toBe(path)
    expect((await git('branch', '--list')).stdout).toBe(branches)
    expect((await exit(agent)).value).toEqual(creation)

    // A start revision asks for a new worktree, which an existing name refuses.
    const refused = await enter({ name: 'new-checkout', from: 'HEAD' }, agent)
    expect(refused.isError && refused.error.info).toEqual({ name: 'WorktreeError', code: 'WORKTREE_ALREADY_EXISTS' })
    // Only a missing worktree leads to creation: other lookup failures are reported as they are.
    const create = vi.spyOn(context.worktrees, 'create')
    const invalid = await enter({ name: '../outside' }, agent)
    expect(invalid.isError && invalid.error.info).toEqual({ name: 'WorktreeError', code: 'WORKTREE_INVALID_ARGUMENT' })
    vi.spyOn(context.worktrees, 'enter').mockRejectedValueOnce(new Error('lookup failed'))
    expect(text(await enter({ name: 'new-checkout' }, agent))).toContain('lookup failed')
    expect(create).not.toHaveBeenCalled()
    expect(context.workingDirectory.get(agent.session)).toBe(repository)

    // Without a name the call creates a worktree with a generated name.
    const generated = await enter({}, agent)
    expect(generated.isError).not.toBe(true)
    expect(generated.value).toMatchObject({ baseCommit, repositoryRoot: repository, created: true })
    expect(create).toHaveBeenCalledOnce()

    const entry = [...context.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-tool-worktree')
    await entry!.fiber!.dispose()
    expect(context.tools.schemas().some(tool => tool.name.endsWith('_worktree'))).toBe(false)
  })
})
