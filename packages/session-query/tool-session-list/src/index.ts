/**
 * Opt-in read-only Workspace and Session metadata tools for the mounted runtime.
 * @module @deepseek-ai/dsh-tool-session-list
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_PAGE_LIMIT, listSessions, listWorkspaces, MAX_PAGE_LIMIT } from './list.ts'

/** Cordis plugin identity. */
export const name = 'tool-session-list'
/** Services needed for header-only listing and live metadata. */
export const inject = ['tools', 'sessions', 'sessionQuery', 'workspaceRegistry', 'sessionProjections']

const pagination = {
  limit: { type: 'integer', description: `Maximum entries to return, from 1 to ${String(MAX_PAGE_LIMIT)}. Defaults to ${String(DEFAULT_PAGE_LIMIT)}.` },
  offset: { type: 'integer', description: 'Number of matching entries to skip. Defaults to 0.' },
} as const

/**
 * Grant tools access to all Workspace and Session metadata in this runtime.
 * @param ctx - scoped context granting these tools to its callers.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_workspace',
    description: 'List workspaces in registry order, including empty workspaces. Returns IDs, titles, paths, and creation and update times.',
    parameters: pagination,
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace_id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            path: { type: 'string', required: true },
            created_at: { type: 'string', required: true, description: 'ISO 8601 creation time.' },
            updated_at: { type: 'string', required: true, description: 'ISO 8601 update time.' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => Promise.resolve(listWorkspaces(ctx, args, exec.signal)),
    presentCall: args => ({ card: 'generic', title: 'List workspaces', kind: 'read', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'list_session',
    description: 'List non-subagent sessions by latest human prompt time, newest first, then by ID. Returns IDs, available titles, and ISO creation and update times. Missing activity metadata uses creation time; unavailable titles are null.',
    parameters: {
      workspace_id: { type: 'string', description: 'Workspace ID from list_workspace. Lists only its member sessions. Omit to list sessions in every workspace and outside all workspaces.' },
      archived: { type: 'boolean', description: 'Return only archived sessions when true, otherwise only unarchived sessions. Defaults to false.' },
      ...pagination,
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true },
            title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            created_at: { type: 'string', required: true, description: 'ISO 8601 creation time.' },
            updated_at: { type: 'string', required: true, description: 'ISO 8601 latest human prompt time, or creation time when unavailable.' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => listSessions(ctx, args, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'List sessions', kind: 'read', rawInput: args }),
  }))
}
