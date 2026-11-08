/**
 * Visible persistent terminals: a terminal registry backend whose sessions are Agent terminals in the
 * Session's sidebar, read-only tools for terminals the user controls, and guidance for both.
 * @module @deepseek-ai/dsh-terminal-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-tools'
import { PanelTerminalBackend } from './backend.ts'
import { type Config, validateConfig } from './config.ts'
import { registerUserTerminalTools } from './tools.ts'

export { Config } from './config.ts'

/** Cordis plugin name. */
export const name = 'terminal-panel'
/** Terminal registry, sidebar terminals, sandbox policy, tool registry and prompt sections. */
export const inject = ['terminals', 'terminalController', 'sandboxPolicy', 'tools', 'systemPrompt']

/** System-prompt guidance on visible terminals. */
export const GUIDANCE = 'Terminals you open with terminal_open appear in the user\'s side panel. The user can watch them and type into them; once the user types into one, you can only read it, and terminal_close then only removes it from your terminal list while its shell and processes keep running for the user. Use visible terminals for long-running processes the user should see, such as dev servers and watchers; keep using bash for short commands whose output you need now. Commands in these terminals run in the session sandbox and cannot request more access; when one is denied permission, run it with bash instead. Never type passwords or one-time codes; ask the user to enter them in the terminal.'

/**
 * Register the sidebar terminal backend, its guidance and, when enabled, the user-terminal tools.
 * @param ctx - plugin context.
 * @param config - Schemastery-resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  ctx.terminals.registerBackend(new PanelTerminalBackend({
    open: (agent, request, signal) => ctx.terminalController.openForAgent(agent, request, signal),
    policy: session => ctx.sandboxPolicy.resolve({ session }),
  }, config))
  ctx.systemPrompt.section({ name: 'tool:pty-panel', order: ctx.systemPrompt.getSectionOrder('TOOL_PTY_PANEL'), text: GUIDANCE })
  if (config.readUserTerminals) registerUserTerminalTools(ctx, ctx.terminalController, config.maxReadBytes)
}
