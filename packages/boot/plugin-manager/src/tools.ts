/** Agent-facing current-profile management using the same service as Web controls. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import type { PluginEntryId } from './types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

/** Required services for the management tool. */
export const inject = ['tools', 'pluginManager', 'sandboxPolicy']

/** Register one management tool for discovery and the four persistent actions.
 * @param ctx Agent-scoped tool registration context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'plugin_manager',
    description: 'List plugins or bundles in the current profile, enable or disable them, install a bundle, or remove an installed bundle. Every action requires danger-full-access permission or approval for this call. Approval does not change the session permission mode. Changes affect every session in this profile. List first to obtain exact identifiers. Package installation can execute allowed build scripts. Live profiles apply changes immediately; startup profiles require restart. Incompatible DSH peer dependencies block installation and activation. Version exemptions risk crashes and data loss: warn the user and obtain explicit permission for the exact plugin and runtime versions before granting one.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption'], description: 'Management operation.' },
      target: { type: 'string', description: 'Plugin entry id, bundle package name, or installation spec, according to action.' },
      enabled: { type: 'boolean', description: 'Required for set operations; defaults to true for installation. For set_version_exemption, true grants and false revokes.' },
      runtimeVersion: { type: 'string', description: 'For set_version_exemption: exact DSH version from list_version_exemptions. Target must be the manifest package-name@version, not an alias or version range.' },
      acceptRisk: { type: 'boolean', description: 'For granting an exemption: true only after warning the user about possible crashes and data loss and receiving explicit permission for this exact plugin/runtime pair. General installation permission is not enough.' },
      approvedBuilds: { type: 'array', items: { type: 'string' }, description: 'For install_bundle: pass names from pendingBuilds only after the user explicitly approves running their install scripts in the conversation. This grants persistent permission for this profile.' },
      registry: { type: 'string', description: 'For install_bundle: the npm registry URL asked first, when the user names one; otherwise the configured registry is asked, and its configured fallbacks while a registry is unreachable.' },
      offset: { type: 'number', description: 'Zero-based list offset; defaults to 0.' },
      limit: { type: 'number', description: 'List page size, from 1 to 100; defaults to 25.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      await approveEscalation({
        requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation',
        justification: `plugin_manager ${JSON.stringify(args)}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`,
      }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
        toolName: 'plugin_manager', signal: exec.signal })
      exec.signal.throwIfAborted()
      const manager = ctx.pluginManager
      switch (args.action) {
        case 'list_version_exemptions':
          return JSON.stringify({ runtimeVersion: getDshRuntimeVersion(), ...manager.listVersionExemptions() })
        case 'set_version_exemption':
          if (args.target === undefined || args.runtimeVersion === undefined || args.enabled === undefined) {
            throw new Error('target package-name@version, runtimeVersion, and enabled are required')
          }
          return JSON.stringify(await manager.setVersionExemption(args.target, args.runtimeVersion, args.enabled, args.acceptRisk))
        case 'list_plugins':
        case 'list_bundles': {
          const offset = args.offset ?? 0
          const limit = args.limit ?? 25
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error('offset must be a non-negative integer and limit must be an integer from 1 to 100')
          }
          const rows = args.action === 'list_plugins' ? await manager.listPlugins() : await manager.listBundles()
          const entries = rows.slice(offset, offset + limit).map(({ meta: _meta, ...row }) =>
            'rows' in row
              ? { ...row, rows: row.rows.map(({ meta: _rowMeta, ...declared }) => declared) }
              : row)
          return JSON.stringify({ entries, total: rows.length,
            nextOffset: offset + entries.length < rows.length ? offset + entries.length : null })
        }
        case 'set_plugin':
        case 'set_bundle': {
          if (args.target === undefined || args.enabled === undefined) throw new Error('target and enabled are required')
          return JSON.stringify(await (args.action === 'set_plugin'
            ? manager.setPluginEnabled(args.target as PluginEntryId, args.enabled)
            : manager.setBundleEnabled(args.target, args.enabled)))
        }
        case 'install_bundle':
          if (args.target === undefined) throw new Error('target package spec is required')
          return JSON.stringify(await manager.installBundle(args.target, {
            ...args.enabled === undefined ? {} : { enabled: args.enabled },
            ...args.approvedBuilds === undefined ? {} : { approvedBuilds: args.approvedBuilds },
            ...args.registry === undefined ? {} : { registry: args.registry },
          }))
        case 'remove_bundle':
          if (args.target === undefined) throw new Error('target bundle name is required')
          return JSON.stringify(await manager.removeBundle(args.target))
        /* v8 ignore next -- tool JSON validation rejects actions outside the declared enum */
        default: return assertNever(args.action)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Manage profile plugins', kind: args.action.startsWith('list_') ? 'read' : 'other', rawInput: args }),
  }))
}
