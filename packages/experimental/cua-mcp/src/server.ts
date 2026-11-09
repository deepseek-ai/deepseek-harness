/** One MCP connection projected onto one DSH Agent that runs Computer Use programs. @module */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-cua'
import { CUA_PROMPT_SECTION_NAME } from '@deepseek-ai/dsh-cua/guidance'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MCP_SERVER_NAME } from './client-config.ts'
import { createConsentAnswerer, type ConsentMode, type ElicitationClient } from './consent.ts'
import { projectToolResult } from './projection.ts'

/** Connection policy and lifetime. */
export interface CuaMcpServerOptions {
  /** Who decides application and pointer consent for the connection's Agent. */
  readonly consent: ConsentMode
  /** Absolute working directory recorded on the connection's Session. */
  readonly cwd: string
  /** Server lifetime; abort cancels every in-flight program before disposal. */
  readonly signal: AbortSignal
}

/** The protocol server and the disposer that releases its Agent. */
export interface CuaMcpServer {
  readonly server: McpServer
  /**
   * Close the protocol connection, let in-flight calls settle, and dispose the connection's Agent, which
   * releases its program environment, native connections, and session-scoped application grants.
   * @returns After the Agent and its retained resources are released.
   */
  dispose(): Promise<void>
}

/** Programs run against the global `cua` object; the result repeats the API reference after a reset. */
const RUN_CODE_DESCRIPTION = 'Run a TypeScript program that observes and operates desktop applications through the global '
  + '`cua` object: select an application, read its accessibility tree, capture window screenshots, click, and type. '
  + 'The program is a sequence of TypeScript REPL statements: top-level `await` works, top-level `return` does not. '
  + 'Only `console.log(...)` output and the value of the final expression come back, followed by every screenshot the '
  + 'program captured as an image. Variables, imported modules, and application or window objects stay in memory for '
  + 'this connection across calls until cua_reset. The first result of a connection starts with the complete `cua` API reference.'

const RESET_DESCRIPTION = 'Discard the program environment of this connection: every variable, import, and application or '
  + 'window object held by earlier cua_run_code calls. Application access grants and the desktop applications themselves '
  + 'are unaffected; the next cua_run_code call starts a fresh environment and its result repeats the `cua` API reference. '
  + 'Use it when a declaration conflicts with an earlier call or the environment has become unusable.'

const INSTRUCTIONS = 'DeepSeek Harness Computer Use: observe and operate desktop applications on this machine. '
  + 'Call cua_run_code with a TypeScript program that uses the global cua object; program state persists across calls '
  + 'on this connection. The first result includes the complete cua API reference; read it before planning further '
  + 'calls. A call may ask the user for application or pointer consent before it proceeds. Call cua_reset to discard program state.'

/** Label DSH records for a program when the client supplies none. */
const DEFAULT_PROGRAM_DESCRIPTION = 'CUA program'

const RUN_CODE_INPUT = z.object({
  code: z.string().min(1).describe('TypeScript REPL statements that use the global cua object; the final expression is returned.'),
  description: z.string().min(1).optional().describe('Short label of what the program does; omitted records "CUA program".'),
  timeoutMs: z.number().int().positive().optional()
    .describe('Elapsed-time budget in milliseconds for this program, including nested cua calls; omitted uses the profile default.'),
})

const NO_PROVIDER = 'Computer Use is not available on this Host: the cua-mcp profile has no active CUA provider. '
  + 'Run the server on a supported macOS Host.'

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError: true }
}

/**
 * Create the MCP server for one stdio connection. The connection's Agent is created when the client finishes
 * initialization or on its first call, mounts the profile's default preset, and lives until disposal.
 * `cua_run_code` calls run one at a time in arrival order through the ordinary tool executor; `cua_reset`
 * bypasses the queue and cancels the running program. Consent questions of that Agent are answered by the
 * configured mode.
 * @param ctx - Profile context with Agents, presets, tools, the system prompt, and the attachment store.
 * @param options - Consent mode, working directory, and lifetime.
 * @returns The protocol server, not yet connected to a transport, and its disposer.
 */
export function createCuaMcpServer(ctx: Context, options: CuaMcpServerOptions): CuaMcpServer {
  const manifest = createRequire(import.meta.url)('../package.json') as { version: string }
  const server = new McpServer({ name: MCP_SERVER_NAME, version: manifest.version }, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  })
  let agent: Agent | undefined
  let creating: Promise<AgentHandle> | undefined
  const connectionAgent = (): Promise<AgentHandle> => {
    creating ??= ctx.agents.create({
      sessionId: SessionId(`cua-mcp-${randomUUID()}`),
      meta: { cwd: options.cwd, agentPreset: ctx.agentPresets.defaultId },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) },
    }).then((handle) => {
      agent = handle.agent
      return handle
    }, (error: unknown) => {
      creating = undefined
      throw error
    })
    return creating
  }
  server.server.oninitialized = () => {
    void connectionAgent().catch((error: unknown) => { ctx.logger.error('Computer Use Agent creation failed: %s', error) })
  }
  const elicitation: ElicitationClient = {
    // Consent rides the 2025 server-to-client request model; the per-request envelope exists only on
    // 2026-07-28 connections, which the README excludes, and such a client receives the thrown error.
    // oxlint-disable-next-line typescript/no-deprecated -- 2025-era accessor, see above.
    supportsElicitation: () => server.server.getClientCapabilities()?.elicitation !== undefined,
    // oxlint-disable-next-line typescript/no-deprecated -- 2025-era request, see above.
    elicit: (message, labels, signal) => server.server.elicitInput({
      mode: 'form', message,
      requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Decision', enum: [...labels] } }, required: ['decision'] },
    }, signal === undefined ? {} : { signal }),
  }
  const unregisterAnswerer = ctx.on('user-questions/request',
    createConsentAnswerer(options.consent, candidate => candidate !== undefined && candidate === agent, elicitation))

  let referenceSent = false
  let calls = 0
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }
  /** Execution rules and the operation reference the provider registered for this Agent. */
  const apiReference = async (subject: Agent): Promise<string> => {
    const definition = ctx.tools.get('cua_run_code', subject)
    const assembly = await ctx.systemPrompt.assemble({ scope: subject })
    const guidance = assembly.sections.find(section => section.name === CUA_PROMPT_SECTION_NAME)?.text
    return [
      ...definition === undefined ? [] : ['## cua_run_code execution rules', definition.description],
      ...guidance === undefined ? [] : ['## cua API reference', guidance],
    ].join('\n\n')
  }
  const runProgram = async (args: z.infer<typeof RUN_CODE_INPUT>, signal: AbortSignal): Promise<CallToolResult> => {
    const programs = ctx.get('cuaPrograms')
    if (programs === undefined) return failure(NO_PROVIDER)
    const subject = (await connectionAgent()).agent
    signal.throwIfAborted()
    const preface: string[] = []
    if (!referenceSent) {
      const reference = await apiReference(subject)
      if (reference !== '') preface.push(reference)
      referenceSent = true
    }
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call', id: ToolCallId(`cua-mcp-${String(++calls)}`), name: 'cua_run_code',
        arguments: JSON.stringify({
          code: args.code, description: args.description ?? DEFAULT_PROGRAM_DESCRIPTION,
          ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        }),
      }],
      agent: subject, signal,
    })
    const outcome = batch.results[0]
    if (outcome === undefined) throw new Error('The tool executor settled without a cua_run_code result')
    return projectToolResult(outcome.result, batch.additionalContexts, {
      attachments: ctx.attachments, target: image => programs.screenshotRequestTarget(image),
    }, signal, preface)
  }

  server.registerTool('cua_run_code', {
    title: 'Computer use program', description: RUN_CODE_DESCRIPTION, inputSchema: RUN_CODE_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => serialize(() => runProgram(args, AbortSignal.any([options.signal, extra.mcpReq.signal]))))

  server.registerTool('cua_reset', {
    title: 'Reset computer use program state', description: RESET_DESCRIPTION, inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const programs = ctx.get('cuaPrograms')
    if (programs === undefined) return failure(NO_PROVIDER)
    const subject = (await connectionAgent()).agent
    try {
      await programs.reset(subject)
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
    referenceSent = false
    return text('Program environment cleared. Application access and native connections are retained; '
      + 'the next cua_run_code call starts a fresh environment and repeats the cua API reference.')
  })

  return {
    server,
    async dispose() {
      unregisterAnswerer()
      await server.close()
      await queue
      if (creating === undefined) return
      const handle = await creating.catch(() => undefined)
      await handle?.dispose()
    },
  }
}
