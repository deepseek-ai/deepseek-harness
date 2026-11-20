/** Shared fixtures: a committed repository, a composition with the policy and directory services, and announced Agents. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { Session, type SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

const execute = promisify(execFile)

/** Git without host configuration or hooks, with a fixed identity for commits. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: 'Grant fixture', GIT_AUTHOR_EMAIL: 'grant@example.invalid',
      GIT_COMMITTER_NAME: 'Grant fixture', GIT_COMMITTER_EMAIL: 'grant@example.invalid',
    },
  })
  return result.stdout.trim()
}

const cleanups: Array<() => Promise<unknown>> = []

/** Run every registered teardown, newest first. */
export async function cleanup(): Promise<void> {
  for (const task of cleanups.splice(0).reverse()) await task()
}

/**
 * A private directory holding a repository with one commit and room for checkouts beside it.
 * @param parent - directory to create it in; the real sandbox suites pass one outside the temporary areas.
 */
export async function scratch(parent = tmpdir()): Promise<{ base: string; repo: string }> {
  const base = await realpath(await mkdtemp(join(parent, 'dsh-sandbox-policy-git-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  return { base, repo: await repository(base, 'repo') }
}

/** Create a repository with one commit at `<base>/<name>`. */
export async function repository(base: string, name: string): Promise<string> {
  const repo = join(base, name)
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'tracked.txt'), 'initial\n')
  await git(repo, 'add', 'tracked.txt')
  await git(repo, 'commit', '-q', '-m', 'initial')
  return repo
}

/** Add a linked worktree of `repo` on a new branch named after its directory. */
export async function worktree(repo: string, base: string, name: string): Promise<string> {
  const path = join(base, name)
  await git(repo, 'worktree', 'add', '-q', '-b', name, path)
  return path
}

/** A local filesystem provider for paths below `base`. */
export async function filesystem(base: string): Promise<FileSystem> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: base })
  return ctx.fs
}

/**
 * The services the plugin injects, under a `workspace-write` default, without the plugin.
 * @param base - fallback workspace root and filesystem base.
 * @param additionalWritableRoots - directories the deployment grants to every Session.
 */
export async function compose(base: string, additionalWritableRoots: string[] = []): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base, additionalWritableRoots })
  await ctx.plugin(WorkingDirectoryService)
  return ctx
}

/**
 * An Agent whose Session was opened in `cwd`; `register` announces it and resolves once creation listeners ran.
 * The Session lives in the Session store, as every product Session does, unless `detached` asks for one that
 * publishes no `session/event`.
 */
export function agentIn(
  ctx: Context, cwd: string, name: string, detached = false,
): { agent: Agent; register: () => ReturnType<Context['agents']['register']> } {
  const scope = ctx.plugin(() => {})
  const id = brandString<SessionId>(name)
  const session = detached
    ? Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
    : ctx.sessions.create(id, { meta: { cwd } })
  const agent: Agent = {
    id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  return { agent, register: () => ctx.agents.register(agent) }
}

/** Announce an Agent in `cwd` and wait for its creation listeners. */
export async function announced(
  ctx: Context, cwd: string, name: string, detached = false,
): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const { agent, register } = agentIn(ctx, cwd, name, detached)
  const registration = register()
  await registration
  return { agent, dispose: async () => { await registration() } }
}

/** The directories a Session's policy grants beyond its workspace root. */
export function extraRoots(ctx: Context, agent: Agent): readonly string[] | undefined {
  return ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots
}
