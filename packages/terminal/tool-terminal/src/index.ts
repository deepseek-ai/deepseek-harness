/**
 * Six model-facing persistent terminal tools. Owner identity comes from the exact
 * tool execution Agent; generic `ctx.jobs` owns background ids and collection.
 * @module @deepseek-ai/dsh-tool-terminal
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalSendOperation, TerminalSendResult, TerminalSessionId as TerminalSessionIdType, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { sendSource } from './background.ts'
import { boundTerminalText, renderList, renderRead, renderSend, renderSpawn } from './render.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'pty-send': 'pty-send'
  }
}

/** Cordis plugin name. */
export const name = 'tool-terminal'
/** Required capability, registry, and prompt services. */
export const inject = ['terminals', 'tools', 'systemPrompt']

/** Default cap for one complete model-facing terminal result. */
export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024
/** Smallest cap that preserves every counter-backed PTY and job id in its creation acknowledgement. */
export const MIN_MAX_RESULT_BYTES = 64

/** Model-facing terminal tool configuration. */
export interface Config {
  /** Expose `run_in_background` and accept background sends (default true). */
  enableRunInBackground?: boolean
  /** Maximum UTF-8 bytes in one complete terminal or task-output result. */
  maxResultBytes?: number
}

/** Schemastery configuration for the terminal tool consumer. */
export const Config: z<Config> = z.object({
  enableRunInBackground: z.boolean().default(true),
  maxResultBytes: z.number().step(1).min(MIN_MAX_RESULT_BYTES).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESULT_BYTES),
})

interface SpawnArgs {
  type: string
  name?: string
  cwd?: string
}

interface SessionArgs {
  sessionId: string
}

interface SendArgs extends SessionArgs {
  text: string
  submit?: boolean
  run_in_background?: boolean
}

interface ReadArgs extends SessionArgs {
  offset?: number
  count?: number
}

interface SignalArgs extends SessionArgs {
  signal: TerminalSignal
}

const SESSION_STATUS_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'running' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'exited' },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
  ],
} as const

const SESSION_SNAPSHOT_PROPERTIES = {
  sessionId: { type: 'string', required: true },
  name: { type: 'string' },
  type: { type: 'string', required: true },
  pid: { type: 'integer' },
  status: { ...SESSION_STATUS_SCHEMA, required: true },
} as const

const SESSION_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: SESSION_SNAPSHOT_PROPERTIES,
} as const

const BACKGROUND_JOB_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'background' },
    jobId: { type: 'string', required: true },
  },
} as const

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('terminal tools require an initiating agent')
  return agent
}

function sessionId(args: SessionArgs): TerminalSessionIdType {
  if (args.sessionId.length === 0) {
    throw new Error('sessionId must be a non-empty string')
  }
  return TerminalSessionId(args.sessionId)
}

function textResult(text: string, maxBytes: number): ContentBlock[] {
  return [{ type: 'text', text: boundTerminalText(text, maxBytes) }]
}

function rawContentText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  return block?.type === 'text' ? block.text : undefined
}

function sendDetail(result: TerminalSendResult): string {
  return result.sessionStatus.kind === 'running'
    ? `wait: ${result.waitReason}`
    : `session exited: ${result.sessionStatus.exitCode ?? result.sessionStatus.signal ?? 'unknown'}`
}

/** Register all terminal tools and the minimal usage guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const enableRunInBackground = config.enableRunInBackground ?? true
  const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < MIN_MAX_RESULT_BYTES) {
    throw new Error(`tool-terminal: maxResultBytes must be a safe integer of at least ${MIN_MAX_RESULT_BYTES}`)
  }
  const finalizeContent: NonNullable<ToolDefinition['finalizeContent']> = (_exec, result) => {
    const raw = rawContentText(result.content)
    return raw === undefined ? undefined : textResult(raw, maxResultBytes)
  }
  ctx.systemPrompt.section({
    name: 'tool:pty',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
    text: 'Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.',
  })

  ctx.tools.register(defineTool({
    name: 'terminal_open',
    description: 'Create a persistent, owner-isolated terminal session from a registered backend type. Use this for shell or REPL state that must survive across tool calls.',
    parameters: {
      type: { type: 'string', required: true, description: 'Registered terminal backend type, usually "shell".' },
      name: { type: 'string', description: 'Optional owner-local display name such as "main" or "gdb".' },
      cwd: { type: 'string', description: 'Initial working directory. Defaults to the deployment workspace root.' },
    },
    finalizeContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SESSION_SNAPSHOT_PROPERTIES,
          motd: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSpawn(value, maxResultBytes) }],
    },
    async execute(args: SpawnArgs, exec) {
      if (args.type.length === 0) throw new Error('type must be a non-empty string')
      const result = await ctx.terminals.spawn(requireAgent(exec.agent), {
        type: args.type,
        ...args.name !== undefined ? { name: args.name } : {},
        ...args.cwd !== undefined ? { cwd: args.cwd } : {},
      }, exec.signal)
      return result
    },
    presentCall: (args) => {
      const parsed = args
      return { card: 'generic', title: `Open terminal ${parsed.name ?? parsed.type}`, kind: 'execute' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_send',
    description: 'Send text to a persistent terminal. By default Enter is submitted and the call waits for a prompt, stdin wait, output silence, timeout, or session exit.'
      + (enableRunInBackground ? ' Background mode returns a job id for job_output/job_kill.' : ''),
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id returned by terminal_open or terminal_list.' },
      text: { type: 'string', required: true, description: 'UTF-8 text to write to the terminal.' },
      submit: { type: 'boolean', description: 'Submit Enter after text (default true). Set false for control characters or incomplete REPL input.' },
      ...enableRunInBackground
        ? { run_in_background: { type: 'boolean' as const, description: 'Return a job id immediately; collect with job_output or stop with job_kill.' } }
        : {},
    },
    finalizeContent,
    output: {
      schema: {
        oneOf: [
          BACKGROUND_JOB_OUTPUT_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              viewport: { type: 'string', required: true },
              waitReason: {
                type: 'string',
                required: true,
                enum: ['stdin_read', 'inferred_idle', 'timeout', 'session_exit'],
              },
              sessionStatus: { ...SESSION_STATUS_SCHEMA, required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderSend(value, maxResultBytes),
      }],
      presentationMeta: (_args, value) => value.kind === 'foreground'
        ? {
          viewport: value.viewport,
          waitReason: value.waitReason,
          sessionStatus: value.sessionStatus,
          truncated: value.truncated,
        }
        : null,
    },
    async execute(args: SendArgs, exec) {
      const owner = requireAgent(exec.agent)
      const id = sessionId(args)
      const request = { text: args.text, submit: args.submit ?? true }
      if (args.run_in_background === true) {
        if (!enableRunInBackground) throw new Error('background terminal sends are disabled by tool-terminal configuration')
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error('background terminal sends require @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        let cancelRequested = false
        let operation: TerminalSendOperation | undefined
        const jobId = jobs.start({
          kind: 'pty-send',
          label: `${id}: ${args.text || '(input)'}`,
          owner: owner.id,
          outputLimitBytes: maxResultBytes,
          output: [sendSource(() => operation)],
          run: () => {
            const started = ctx.terminals.startSend(owner, id, request)
            operation = started
            return {
              cancel: () => {
                cancelRequested = true
                started.cancel()
              },
              done: started.done.then(
                result => ({ status: cancelRequested ? 'killed' as const : 'completed' as const, detail: sendDetail(result) }),
                (error: unknown) => ({ status: 'failed' as const, detail: String(error) }),
              ),
            }
          },
        })
        return { kind: 'background' as const, jobId }
      }
      const operation = ctx.terminals.startSend(owner, id, { ...request, signal: exec.signal })
      const result = await operation.done
      if (exec.signal.aborted) throw new Error('terminal send aborted')
      return { kind: 'foreground' as const, ...result }
    },
    presentCall(args) {
      const parsed = args as Partial<SendArgs>
      if (parsed.run_in_background === true) {
        return { card: 'generic', title: `Send to terminal ${parsed.sessionId as string} in background`, kind: 'execute', rawInput: parsed.text }
      }
      // Keep these Host-only fallbacks aligned with the conversation locale
      // keys `terminal.sendInput` and `terminal.session` used by Web.
      return { card: 'terminal', title: parsed.text || '(send input)', description: `Terminal ${parsed.sessionId as string}` }
    },
    presentResult(args, result) {
      if ((args as Partial<SendArgs>).run_in_background === true || result.isError) return undefined
      const raw = rawContentText(result.content)
      return raw === undefined ? undefined : { card: 'terminal', output: raw }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_read',
    description: 'Read a bounded page of retained output from a persistent terminal without sending input.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      offset: { type: 'number', description: 'Newest-relative line offset (default 0).' },
      count: { type: 'number', description: 'Requested line count (default 500; backend caps apply).' },
    },
    finalizeContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          totalLines: { type: 'integer', required: true },
          lineBegin: { type: 'integer', required: true },
          lineEnd: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRead(value, maxResultBytes) }],
    },
    execute(args: ReadArgs, exec) {
      const result = ctx.terminals.read(requireAgent(exec.agent), sessionId(args), {
        ...args.offset !== undefined ? { offset: args.offset } : {},
        ...args.count !== undefined ? { count: args.count } : {},
      })
      return Promise.resolve(result)
    },
    presentCall: args => ({ card: 'generic', title: `Read terminal ${(args).sessionId}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_signal',
    description: 'Send an allowed signal to the current foreground process group of a persistent terminal.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      signal: { type: 'string', required: true, enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'], description: 'Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close.' },
    },
    finalizeContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true, const: true },
          targetPgid: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `delivered ${args.signal} to foreground process group ${value.targetPgid}` }],
    },
    async execute(args: SignalArgs, exec) {
      return ctx.terminals.signal(requireAgent(exec.agent), sessionId(args), args.signal)
    },
    presentCall: args => ({ card: 'generic', title: `Signal terminal ${args.sessionId}`, kind: 'execute', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_close',
    description: 'Close one persistent terminal and wait until its captured owned process tree is gone.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
    },
    finalizeContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          outcome: { type: 'string', required: true, enum: ['closed', 'already-closing'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'closed'
          ? `closed terminal session ${value.sessionId}`
          : `terminal session ${value.sessionId} was already closing`,
      }],
    },
    async execute(args: SessionArgs, exec) {
      const id = sessionId(args)
      const closed = await ctx.terminals.kill(requireAgent(exec.agent), id)
      return { sessionId: id, outcome: closed ? 'closed' as const : 'already-closing' as const }
    },
    presentCall: args => ({ card: 'generic', title: `Close terminal ${(args).sessionId}`, kind: 'delete' }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_list',
    description: 'List persistent terminal sessions owned by the current agent.',
    parameters: {},
    finalizeContent,
    output: {
      schema: { type: 'array', items: SESSION_SNAPSHOT_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: renderList(value, maxResultBytes) }],
    },
    execute(_args: Record<string, never>, exec) {
      return Promise.resolve(ctx.terminals.list(requireAgent(exec.agent)))
    },
    presentCall: () => ({ card: 'generic', title: 'List terminal sessions', kind: 'read' }),
  }))
}
