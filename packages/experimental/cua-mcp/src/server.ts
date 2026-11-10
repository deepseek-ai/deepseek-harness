/** One MCP connection projected onto one DSH Agent that runs Computer Use programs. @module */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-cua'
import { CUA_PROMPT_SECTION_NAME } from '@deepseek-ai/dsh-cua/guidance'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Server, specTypeSchemas, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
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

/** The protocol server, the Agent it serves, and the disposer that releases both. */
export interface CuaMcpServer {
  /** Low-level protocol server, not yet connected to a transport. */
  // oxlint-disable-next-line typescript/no-deprecated -- the SDK keeps this class for dynamic tool lists, see createCuaMcpServer.
  readonly server: Server
  /** The connection's Agent: owner of the program environment, native connection, and session grants. */
  readonly agent: Agent
  /**
   * Close the protocol connection, let in-flight calls settle, and dispose the connection's Agent, which
   * releases its program environment, native connections, and session-scoped application grants.
   * @returns After the Agent and its retained resources are released.
   */
  dispose(): Promise<void>
}

/** MCP server name clients address; external tool names become `mcp__dsh_cua__cua_run_code` in Claude Code. */
const MCP_SERVER_NAME = 'dsh_cua'

/** The DSH tool whose registration for the connection's Agent is served as the MCP tool of the same name. */
const PROGRAM_TOOL = 'cua_run_code'

/**
 * Registration fields a program may not use through MCP: a sandbox escalation needs an approval answerer this
 * profile does not have, so the projection omits them and a call naming them is refused before execution.
 */
const ESCALATION_FIELDS = ['sandbox_permissions', 'justification'] as const

/** MCP presentation of the program tool; its name, description, and schema come from the registration. */
const PROGRAM_TOOL_PRESENTATION = {
  title: 'Computer use program',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const

/** The host-level reset is not a DSH tool, so its definition lives here. */
const RESET_TOOL: Tool = {
  name: 'cua_reset',
  title: 'Reset computer use program state',
  description: 'Discard the program environment of this connection: every variable, import, and application or '
    + 'window object held by earlier cua_run_code calls. Application access grants and the desktop applications themselves '
    + 'are unaffected; the next cua_run_code call starts a fresh environment and its result repeats the `cua` API reference. '
    + 'Use it when a declaration conflicts with an earlier call or the environment has become unusable.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

const INSTRUCTIONS = 'DeepSeek Harness Computer Use: observe and operate desktop applications on this machine. '
  + 'Call cua_run_code with a TypeScript program that uses the global cua object; program state persists across calls '
  + 'on this connection. The first result includes the complete cua API reference; read it before planning further '
  + 'calls. A call may ask the user for application or pointer consent before it proceeds. Call cua_reset to discard program state.'

const NO_PROVIDER = 'Computer Use is not available on this Host: the cua-mcp profile has no active CUA provider. '
  + 'Run the server on a supported macOS Host.'

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError: true }
}

/**
 * Project the Agent's `cua_run_code` registration onto an MCP tool: name, description, and parameters as registered,
 * minus the sandbox-escalation fields, checked against the protocol's tool type so an unrepresentable schema fails
 * the listing instead of the client.
 */
function projectProgramTool(definition: ToolDefinition): Tool {
  const { properties, required, ...rest } = definition.parameters
  const inputSchema = {
    ...rest,
    ...properties === undefined ? {} : {
      properties: Object.fromEntries(Object.entries(properties as Record<string, unknown>)
        .filter(([field]) => !ESCALATION_FIELDS.includes(field as typeof ESCALATION_FIELDS[number]))),
    },
    ...Array.isArray(required)
      ? { required: required.filter(field => !ESCALATION_FIELDS.includes(field as typeof ESCALATION_FIELDS[number])) }
      : {},
  }
  const result = specTypeSchemas.Tool['~standard'].validate({
    name: definition.name, description: definition.description, inputSchema, ...PROGRAM_TOOL_PRESENTATION,
  })
  if (result.issues !== undefined) {
    throw new Error(`The ${definition.name} registration is not an MCP tool: ${result.issues.map(issue => issue.message).join('; ')}`)
  }
  return result.value
}

/**
 * Create the MCP server for one stdio connection. The connection's Agent is created first, mounts the profile's
 * default preset, and lives until disposal; the provider registers `cua_run_code` for it, and each `tools/list`
 * re-reads that registration. `cua_run_code` calls pass their arguments to the ordinary tool executor unchanged,
 * one at a time in arrival order, so argument validation and unknown names are answered by DSH; `cua_reset`
 * bypasses the queue and cancels the running program. Consent questions of that Agent are answered by the
 * configured mode. A call the executor cannot settle, including a cancelled one, fails as a protocol error.
 * @param ctx - Profile context with Agents, presets, tools, the system prompt, and the attachment store.
 * @param options - Consent mode, working directory, and lifetime.
 * @returns The protocol server, not yet connected to a transport, its Agent, and its disposer.
 * @throws Error when the Agent cannot be created; nothing is served then.
 */
export async function createCuaMcpServer(ctx: Context, options: CuaMcpServerOptions): Promise<CuaMcpServer> {
  const manifest = createRequire(import.meta.url)('../package.json') as { version: string }
  const handle = await ctx.agents.create({
    sessionId: SessionId(`cua-mcp-${randomUUID()}`),
    meta: { cwd: options.cwd, agentPreset: ctx.agentPresets.defaultId },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx) },
  })
  const { agent } = handle
  // The listing is projected from the registry at each request; McpServer owns tools/list and tools/call once a tool
  // is registered on it, so this advanced use builds on the low-level protocol server the SDK keeps for that case.
  // oxlint-disable-next-line typescript/no-deprecated -- low-level server for a dynamic tool list, see above.
  const server = new Server({ name: MCP_SERVER_NAME, version: manifest.version }, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  })
  const elicitation: ElicitationClient = {
    // Consent rides the 2025 server-to-client request model; the per-request envelope exists only on
    // 2026-07-28 connections, which the README excludes, and such a client receives the thrown error.
    // oxlint-disable-next-line typescript/no-deprecated -- 2025-era accessor, see above.
    supportsElicitation: () => server.getClientCapabilities()?.elicitation !== undefined,
    // oxlint-disable-next-line typescript/no-deprecated -- 2025-era request, see above.
    elicit: (message, labels, signal) => server.elicitInput({
      mode: 'form', message,
      requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Decision', enum: [...labels] } }, required: ['decision'] },
    }, signal === undefined ? {} : { signal }),
  }
  const unregisterAnswerer = ctx.on('user-questions/request',
    createConsentAnswerer(options.consent, candidate => candidate === agent, elicitation))

  let referenceSent = false
  let calls = 0
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }
  /** The provider's `cua` guidance for this Agent, placed before the first program result of each environment. */
  const apiReference = async (): Promise<string | undefined> => {
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    const guidance = assembly.sections.find(section => section.name === CUA_PROMPT_SECTION_NAME)?.text
    return guidance === undefined ? undefined : `## cua API reference\n\n${guidance}`
  }
  const runTool = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> => {
    const escalation = ESCALATION_FIELDS.filter(field => field in args)
    if (name === PROGRAM_TOOL && escalation.length > 0) {
      return failure(`Program sandbox escalation is not available through cua-mcp: remove ${escalation.join(' and ')}. `
        + 'The launch-time DSH_PERMISSION_MODE selects the file sandbox of program processes.')
    }
    const batch = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`cua-mcp-${String(++calls)}`), name, arguments: JSON.stringify(args) }],
      agent, signal,
    }))
    const outcome = batch.results[0]
    if (outcome === undefined) throw new Error(`The tool executor settled without a ${name} result`)
    const preface: string[] = []
    if (name === PROGRAM_TOOL && !referenceSent) {
      const reference = await apiReference()
      if (reference !== undefined) {
        preface.push(reference)
        referenceSent = true
      }
    }
    const programs = ctx.get('cuaPrograms')
    return projectToolResult(outcome.result, batch.additionalContexts, {
      attachments: ctx.attachments, target: image => programs?.screenshotRequestTarget(image),
    }, signal, preface)
  }
  const resetEnvironment = async (): Promise<CallToolResult> => {
    const programs = ctx.get('cuaPrograms')
    if (programs === undefined) return failure(NO_PROVIDER)
    try {
      await programs.reset(agent)
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
    referenceSent = false
    return text('Program environment cleared. Application access and native connections are retained; '
      + 'the next cua_run_code call starts a fresh environment and repeats the cua API reference.')
  }

  server.setRequestHandler('tools/list', () => {
    const definition = ctx.tools.get(PROGRAM_TOOL, agent)
    return { tools: [...definition === undefined ? [] : [projectProgramTool(definition)], RESET_TOOL] }
  })
  server.setRequestHandler('tools/call', (request, extra) => {
    const { name, arguments: args = {} } = request.params
    if (name === RESET_TOOL.name) return resetEnvironment()
    return serialize(() => runTool(name, args, AbortSignal.any([options.signal, extra.mcpReq.signal])))
  })

  return {
    server,
    agent,
    async dispose() {
      unregisterAnswerer()
      await server.close()
      await queue
      await handle.dispose()
    },
  }
}
