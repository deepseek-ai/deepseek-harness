/**
 * Model-facing Consumer of the `ctx.shell` capability seam. While a job
 * registry is composed, every call registers its process with `ctx.jobs` as
 * it starts: `run_in_background` returns the id at once, and a foreground call
 * waits on its job until the command finishes or the wait times out, at which
 * point it returns the same id. Without a registry the tool is foreground-only
 * and the executor's deadline kills the command.
 *
 * TODO(permissions): deployment policy belongs in `tools/pre-execute` and
 * sandboxing executors; see docs/architecture.md § Where new behavior goes.
 * @module @deepseek-ai/dsh-tool-bash
 */

import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, sep } from 'node:path'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolDefinition, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry, JobView } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, sandboxPermissionsDescription, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { processJob, processOutcome, processSources, ringDelta } from './background.ts'
import { parseExitStatus, renderJobRead, renderPromoted, renderResult } from './render.ts'

export const name = 'tool-bash'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Configuration for the bash tool. */
export interface Config {
  /**
   * Expose `run_in_background` while a job registry is composed (default
   * true); disabled calls are also rejected. Without a registry the tool is
   * foreground-only regardless.
   */
  enableRunInBackground?: boolean
  /**
   * Keep a foreground command that reaches its timeout running as a
   * background job instead of killing it (default true). Applies only while
   * background execution is available: with `enableRunInBackground` false or
   * no job registry, the executor's deadline kills the command. A foreground
   * command the registry refuses at its start (admission or a missing
   * controller) also runs under the deadline kill.
   */
  promoteOnTimeout?: boolean
}

/** Runtime configuration schema for the bash tool plugin. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  /** Optional for an omitted or repeated effective mode; widening requires a non-empty reason. */
  justification?: string
}

function validateBashArgs(args: BashToolArgs, effectiveMode: SandboxMode | undefined): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode) return
  const justification = args.sandbox_permissions === undefined && args.justification?.trim() === ''
    ? undefined
    : args.justification
  validateEscalationArgs(args.sandbox_permissions, justification)
}

function bashDescription(): string {
  return 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
    + `Managed \`$${DSH_ENV_PREFIX}*\` variables expose current harness environment facts. `
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.'
}

/**
 * Present foreground calls as terminals and background starts as generic cards.
 * The command remains the title on both paths; foreground cwd is passed through
 * for the bridge to resolve, while background descriptions remain card content.
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  const isPromoted = (result as { value?: { kind?: unknown } }).value?.kind === 'promoted'
  // Background acknowledgements, promotions, and errors have no terminal exit status.
  if (isBackground || isPromoted || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  // The exit marker becomes the card's exit pill, so it leaves the output body.
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so workdir
 * and confinement use the exact same per-call identity.
 */
function resolveWorkdir(
  modelWorkdir: string | undefined,
  exec: { agent?: Agent },
  policyWorkspaceRoot?: string,
): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? headerCwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return `${sessionCwd}${sep}${modelWorkdir}`
  }
  return modelWorkdir
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalBashResult(result: ShellRunResult) {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}

/** The structured abort the foreground paths throw when the caller cancels the call. */
function toolAborted(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** A registered command: its id, the process once the starter spawned it, and the reason an outside kill gave. */
interface StartedJob {
  readonly id: JobId
  readonly process: () => ShellExecution | undefined
  readonly stopped: () => string | undefined
}

/** Canonical background-handle properties shared by the bash output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const backgroundEnabled = config.enableRunInBackground ?? true
  // Keeping a timed-out command needs the whole background surface: the job
  // tools to collect and stop it, and the registry itself at execution time.
  const promoteOnTimeout = (config.promoteOnTimeout ?? true) && backgroundEnabled
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing')
  }
  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to
   * {@link approveEscalation}. This tool contributes only the composition
   * guard (the fields are unadvertised without a sandboxing executor, yet
   * schema validation checks advertised keys only, so an unadvertised
   * `sandbox_permissions` still reaches execute) and the approval
   * ingredients. The shared policy resolver is required whenever the executor
   * advertises confinement, so a split composition fails at tool-plugin load.
   */
  const approveBashEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'bash',
        signal: exec.signal,
      },
    )
  }

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  /**
   * One registration of the `bash` tool. With a registry, every call
   * registers its process as a job at its start; without one the tool is
   * foreground-only and the executor's deadline kills the command.
   */
  const bashTool = (jobs: JobRegistry | undefined): ToolDefinition => {
    const background = jobs !== undefined
    const promote = background && promoteOnTimeout
    /** Register the command as a job; the process spawns inside the starter, after admission. */
    const startJob = (registry: JobRegistry, args: BashToolArgs, exec: ToolExecution, spec: ShellExecSpec): StartedJob => {
      let proc: ShellExecution | undefined
      let stopped: string | undefined
      const id = registry.start({
        kind: 'bash',
        label: args.command,
        ...exec.agent ? { owner: exec.agent.id } : {},
        output: processSources(() => proc),
        run: () => {
          const hooks = processJob(
            async (signal) => {
              proc = await ctx.shell.execute({ ...spec, signal })
              return proc
            },
            started => processOutcome(started, escalationModes),
          )
          return {
            done: hooks.done,
            // A kill from outside this call (the human's, a parallel job_kill)
            // reaches the process here; its reason is what the model reads.
            cancel: (reason) => {
              stopped = reason
              hooks.cancel(reason)
            },
          }
        },
      })
      return { id, process: () => proc, stopped: () => stopped }
    }
    /** Wait on a registered foreground command until it settles or the timeout passes. */
    const waitOnJob = async (registry: JobRegistry, attached: StartedJob, exec: ToolExecution, spec: ShellExecSpec) => {
      const owner = exec.agent?.id
      const timeoutMs = spec.timeoutMs
      /**
       * Stop the job on this call's own account and stay on it until it
       * settles, so the settlement is `awaited` and no completion notice
       * follows a result this call already carries; the record then leaves
       * with the call, as the model never saw the id.
       */
      const stop = async (reason: string): Promise<JobView> => {
        registry.kill(attached.id, owner, reason)
        const settled = await registry.wait(attached.id, timeoutMs, owner)
        if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
        return settled
      }
      let view: JobView
      try {
        view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)
      } catch {
        // A wait on the caller's own live job rejects only for the caller's
        // abort: the model's call is over, so the command goes with it, as
        // under the deadline kill.
        await stop('tool call aborted')
        throw toolAborted()
      }
      if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
        // The wait expired while preparation still ran: nothing is running
        // to keep, so this is the deadline's preparation timeout, with the
        // settled empty result the executor's own deadline would have given.
        await stop('timed out during preparation')
        return {
          kind: 'foreground' as const,
          exitCode: null,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
          ...spec.sandboxPolicy !== undefined ? { sandbox: { mode: spec.sandboxPolicy.mode, denied: false } } : {},
        }
      }
      if (view.status === 'running' || view.status === 'stopping') {
        // The wait timed out: the job keeps running. One consuming read seeds
        // the result with the output so far, so `job_output` continues exactly
        // where this result stops.
        const read = registry.read(attached.id, owner)
        return {
          kind: 'promoted' as const,
          jobId: attached.id,
          timeoutMs,
          output: renderJobRead(
            ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes,
          ),
        }
      }
      // Settled while the call waited: the model never saw the id, so the
      // record leaves the registry with this result. The process handle keeps
      // the split streams and classification the foreground result needs.
      registry.remove(attached.id, owner)
      const process = attached.process()
      // No process was published: the starter failed before the spawn, and the
      // job's terminal detail is the failure the foreground projection would
      // have rejected with.
      if (process === undefined) throw new Error(view.detail)
      const result = await process.result()
      const stopped = attached.stopped()
      return { kind: 'foreground' as const, ...canonicalBashResult(result), ...stopped !== undefined ? { stopped } : {} }
    }
    return defineTool({
      name: 'bash',
      description: bashDescription(),
      parameters: {
        command: { type: 'string', required: true, description: 'The bash command to execute.' },
        description: {
          type: 'string',
          required: true,
          description: 'Clear, concise description of what this command does in active voice, '
            + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
            + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
        },
        timeoutMs: {
          type: 'number',
          description: promote
            ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
            : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
        },
        workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
        ...background ? {
          run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
        } : {},
        ...escalationModes.length > 0 ? {
          sandbox_permissions: {
            type: 'string' as const,
            enum: [...escalationModes],
            description: sandboxPermissionsDescription('command'),
          },
          justification: {
            type: 'string' as const,
            description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. '
              + 'Use the language of the user’s current request.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: BACKGROUND_OUTPUT_PROPERTIES,
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'promoted' },
                jobId: { type: 'string', required: true },
                timeoutMs: { type: 'number', required: true },
                output: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                timedOut: { type: 'boolean', required: true },
                aborted: { type: 'boolean', required: true },
                stopped: { type: 'string' },
                timeoutMs: { type: 'number', required: true },
                stdout: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                stderr: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                sandbox: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', required: true },
                    denied: { type: 'boolean', required: true },
                    enforcement: { type: 'string' },
                    runnerFailed: { type: 'boolean' },
                  },
                },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background job ${value.jobId}`
            : value.kind === 'promoted'
              ? renderPromoted(value)
              : renderResult(value as { kind: 'foreground' } & ShellRunResult, escalationModes),
        }],
      },
      async execute(args: BashToolArgs, exec) {
        // Description is display metadata; workdir defaults to the caller's session.
        const standingPolicy = resolveSandboxPolicy(exec)
        validateBashArgs(args, standingPolicy?.mode)
        const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
          ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
          : undefined
        const policy = approvedMode === undefined
          ? standingPolicy
          : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
        const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
        const dshEnv = ctx.shellEnv.collect(exec)
        const request: ShellExecRequest = {
          command: args.command,
          ...workdir !== undefined ? { workdir } : {},
          ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
          dshEnv,
          ...policy !== undefined ? { sandboxPolicy: policy } : {},
        }
        if (args.run_in_background === true) {
          // Undeclared keys are allowed, so schema omission also needs enforcement.
          if (!backgroundEnabled) {
            throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
          }
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // The caller owns cancellation until ctx.jobs commits detached ownership.
          if (exec.signal.aborted) throw toolAborted()
          return { kind: 'background' as const, jobId: startJob(jobs, args, exec, ctx.shell.resolve({ ...request, onExpiry: 'none' })).id }
        }
        // A foreground call is a job the tool waits on, so the command is
        // visible and killable from the moment it starts and outlives the wait
        // when the timeout passes. Admission refused at the start (the owner's
        // job limit, no controller) runs the command under the deadline kill
        // instead, exactly as a composition without a registry does.
        if (jobs !== undefined && promote) {
          const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
          let attached: StartedJob | undefined
          try {
            attached = startJob(jobs, args, exec, spec)
          } catch (error) {
            ctx.logger.warn(`bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
          }
          if (attached !== undefined) return waitOnJob(jobs, attached, exec, spec)
        }
        const foreground = await ctx.shell.execute(ctx.shell.resolve({ ...request, signal: exec.signal }))
        const result = await foreground.result()
        if (result.aborted) throw toolAborted()
        return { kind: 'foreground' as const, ...canonicalBashResult(result) }
      },
      presentCall: presentBashCall,
      presentResult: presentBashResult,
    })
  }

  // The background surface follows the registry. The foreground-only variant
  // registers now unless a registry is already composed, the job-backed
  // variant replaces it for as long as `ctx.jobs` is present, and the
  // foreground-only one returns when the registry unloads while this plugin
  // stays. Both registrations belong to this plugin's own fiber.
  if (!backgroundEnabled) {
    ctx.tools.register(bashTool(undefined))
    return
  }
  let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(bashTool(undefined)) : undefined
  ctx.inject(['jobs'], (jobCtx) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = ctx.tools.register(bashTool(jobCtx.jobs))
    jobCtx.effect(() => () => {
      unregister()
      if (ctx.fiber.state === FiberState.ACTIVE) foregroundOnly = ctx.tools.register(bashTool(undefined))
    })
  })
}
