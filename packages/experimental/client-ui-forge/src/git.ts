/** Read-only Git inspection of a Session's current directory in the Session's execution world. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { baseBranches, parseName, parseRemotes, parseTopLevel } from './parse.ts'
import type { GitRemote } from './parse.ts'
import type { ForgeBranches, ForgeCheckout } from './types.ts'

/** Resolved Git executable and process limits. */
export interface GitConfig {
  /** Git executable name or absolute path. */
  readonly gitCommand: string
  /** Deadline in milliseconds for one command, including executable lookup and confinement. */
  readonly gitTimeoutMs: number
  /** Termination grace period in milliseconds for each process. */
  readonly graceMs: number
  /** Maximum captured bytes per output stream. */
  readonly maxOutputBytes: number
}

/** Checkout facts with the upstream and remotes used to recognize the code host. */
export interface Inspection {
  /** Facts the panel shows. */
  readonly checkout: ForgeCheckout
  /** Canonical Git directory shared by every checkout of the repository. */
  readonly commonDir: string
  /** Upstream branch such as `origin/main`, or null when none is configured or HEAD is detached. */
  readonly upstream: string | null
  /** Remotes in listed order. */
  readonly remotes: readonly GitRemote[]
}

/** Complete output of one Git command that exited with an allowed code. */
export interface GitOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one Git subcommand in a fixed directory; output with an exit code outside `allowedExitCodes` throws. */
export type Git = (name: string, args: readonly string[], allowedExitCodes?: readonly number[]) => Promise<GitOutput>

/** Thrown when a Git command prints more than `maxOutputBytes` on standard output. */
export class GitOutputTooLarge extends Error {
  override name = 'GitOutputTooLarge'
}

/**
 * Clear inherited repository, configuration, and replacement-ref selectors;
 * disable prompts, optional index writes, and lazy fetches of missing objects.
 * Git older than 2.45 ignores `GIT_NO_LAZY_FETCH`.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
}

/** Arguments before every subcommand: no index refresh writes, hooks, or filesystem monitor. */
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const

const NOT_A_CHECKOUT = /not a git repository|must be run in a work tree/i

/**
 * Inspect the checkout containing `directory`. Every command runs through the
 * mounted subprocess provider under a read-only confinement of the Session's
 * sandbox policy and reads refs and configuration only, never the working
 * tree. The top-level and shared Git directories Git prints are resolved
 * through `ctx.fs` into canonical process paths, the form the
 * working-directory service records.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - executable and process limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param directory - absolute directory to inspect.
 * @param signal - cancellation of every command.
 * @returns the checkout facts, shared Git directory, upstream, and remotes, or undefined when `directory` is not inside a checkout.
 * @throws when Git cannot run, fails, times out, or prints more than `maxOutputBytes`.
 */
export async function inspectCheckout(
  ctx: Context,
  config: GitConfig,
  session: Session,
  directory: string,
  signal: AbortSignal,
): Promise<Inspection | undefined> {
  const git = gitIn(ctx, config, session, directory, signal)
  const top = await git('rev-parse', ['rev-parse', '--show-toplevel'], [0, 128])
  if (top.exitCode !== 0) {
    if (NOT_A_CHECKOUT.test(top.stderr)) return undefined
    throw new Error(`git rev-parse failed: ${firstLine(top.stderr)}`)
  }
  const [root, commonDir, gitDir, branch, commit, upstream, remotes] = await together(signal, (signal) => {
    const git = gitIn(ctx, config, session, directory, signal)
    const canonical = async (path: string): Promise<string> => ctx.fs.processPath(await ctx.fs.resolve(path, { cwd: directory, signal }))
    return [
      canonical(parseTopLevel(top.stdout)),
      git('common-dir', ['rev-parse', '--path-format=absolute', '--git-common-dir']).then<string>(output => canonical(parseTopLevel(output.stdout))),
      git('git-dir', ['rev-parse', '--path-format=absolute', '--git-dir']).then<string>(output => canonical(parseTopLevel(output.stdout))),
      currentBranch(git),
      headCommit(git),
      git('upstream', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128]),
      git('remote', ['remote', '-v']),
    ] as const
  })
  return {
    // A linked worktree keeps its own Git directory under the shared one; a submodule or a separate Git directory does not.
    checkout: { root, branch, linked: gitDir !== commonDir, commit },
    commonDir,
    upstream: upstream.exitCode === 0 ? parseName(upstream.stdout) : null,
    remotes: parseRemotes(remotes.stdout),
  }
}

/**
 * List the local branches that can start a worktree of the checkout containing
 * `directory`, under the same confinement as {@link inspectCheckout}.
 * @param ctx - context that provides `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - executable and process limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param directory - absolute directory inside the checkout.
 * @param limit - most branch names to return.
 * @param signal - cancellation of every command.
 * @returns the checked-out branch and local branches, the checked-out one first and then most recently committed first.
 * @throws when `directory` is not inside a checkout, or Git cannot run, fails, times out, or prints more than `maxOutputBytes`.
 */
export async function listBranches(
  ctx: Context,
  config: GitConfig,
  session: Session,
  directory: string,
  limit: number,
  signal: AbortSignal,
): Promise<ForgeBranches> {
  const [current, refs] = await together(signal, (signal) => {
    const git = gitIn(ctx, config, session, directory, signal)
    return [
      currentBranch(git),
      git('for-each-ref', ['for-each-ref', '--sort=-committerdate', `--count=${limit}`, '--format=%(refname:lstrip=2)', 'refs/heads/']),
    ] as const
  })
  return { current, branches: baseBranches(current, refs.stdout, limit) }
}

/** A failed read cancels its siblings and returns only after every read has finished cleanup. */
async function together<T extends readonly Promise<unknown>[]>(
  signal: AbortSignal,
  start: (signal: AbortSignal) => T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const stop = new AbortController()
  const tasks = start(AbortSignal.any([signal, stop.signal]))
  try {
    return await Promise.all(tasks)
  } catch (error) {
    stop.abort(error)
    await Promise.allSettled(tasks)
    throw error
  }
}

/**
 * Report whether a local branch exists, under the same confinement as {@link inspectCheckout}.
 * @param ctx - context that provides `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - executable and process limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param repositoryRoot - absolute root of a checkout of the repository.
 * @param branch - local branch name.
 * @param signal - cancellation of the command.
 * @returns whether `refs/heads/<branch>` exists.
 * @throws when Git cannot run, fails, times out, or prints more than `maxOutputBytes`.
 */
export async function hasBranch(
  ctx: Context,
  config: GitConfig,
  session: Session,
  repositoryRoot: string,
  branch: string,
  signal: AbortSignal,
): Promise<boolean> {
  const git = gitIn(ctx, config, session, repositoryRoot, signal)
  const ref = await git('show-ref', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
  return ref.exitCode === 0
}

/**
 * Bind the confined Git runner to one Session and directory: every command
 * runs under a read-only confinement of the Session's sandbox policy with the
 * scrubbed environment, the fixed command prefix, and `config`'s limits.
 * @param ctx - context that provides `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - executable and process limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param directory - working directory of every command.
 * @param signal - cancellation of every command.
 * @returns the runner.
 */
export function gitIn(ctx: Context, config: GitConfig, session: Session, directory: string, signal: AbortSignal): Git {
  const policy: SandboxPolicy = { ...ctx.sandboxPolicy.resolve({ session, mode: 'read-only' }), mode: 'read-only' }
  return (name, args, allowedExitCodes = [0]) => runGit(ctx, config, policy, directory, name, args, signal, allowedExitCodes)
}

/** Read the checked-out branch, including an unborn one; null when HEAD is detached. */
async function currentBranch(git: Git): Promise<string | null> {
  const head = await git('symbolic-ref', ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
  return head.exitCode === 0 ? parseName(head.stdout) : null
}

/** Read the abbreviated commit HEAD names; null while the checked-out branch has no commit. */
async function headCommit(git: Git): Promise<string | null> {
  const head = await git('head', ['rev-parse', '--short', 'HEAD'], [0, 128])
  return head.exitCode === 0 ? parseName(head.stdout) : null
}

async function runGit(
  ctx: Context,
  config: GitConfig,
  policy: SandboxPolicy,
  cwd: string,
  name: string,
  args: readonly string[],
  signal: AbortSignal,
  allowedExitCodes: readonly number[],
): Promise<GitOutput> {
  using timeout = deadline(signal, config.gitTimeoutMs, 'FORGE_PANEL_GIT_TIMEOUT')
  const program = await ctx.subprocess.resolveExecutable(config.gitCommand, undefined, timeout.signal)
  const confined = await ctx.sandbox.confine([program, ...GIT_PREFIX, ...args], policy, timeout.signal)
  timeout.signal.throwIfAborted()
  /* jscpd:ignore-start -- the bounded spawn-and-collect sequence matches the
     worktree service's runner; the two differ in policy, environment, and
     error text, and a shared helper would make this panel depend on the
     worktree package or add a subprocess API for two experimental callers. */
  const child = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd,
    env: GIT_ENV,
    signal: timeout.signal,
    graceMs: config.graceMs,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
  })
  try {
    const outcome = await child.done
    timeout.signal.throwIfAborted()
    // The spawn spec above collects both streams.
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    const stderr = captured.stderr.readFrom(0)
    if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
      throw new Error(`git ${name} failed (${outcome.signal ?? outcome.exitCode}): ${firstLine(stderr.text)}`)
    }
    if (stdout.lossy) throw new GitOutputTooLarge(`git ${name} output exceeds maxOutputBytes`)
    return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
  /* jscpd:ignore-end */
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? 'no diagnostic'
}
