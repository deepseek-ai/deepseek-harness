/** Desktop tool exposing bundled interpreters without modifying command resolution. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installPrimaryRuntime, type WorkspaceDependencies } from './primary-runtime.ts'

export const name = 'desktop-workspace-dependencies'
export const inject = ['tools']

/** Application-selected payload and installation directories. */
export interface Config {
  readonly source: string
  readonly root: string
}

/**
 * Register the read-only path query, preparing bundled files on its first invocation.
 * @param ctx - Desktop tool registry owner.
 * @param config - Application payload and fixed installation paths.
 */
export function apply(ctx: Context, config: Config): void {
  let installation: Promise<WorkspaceDependencies> | undefined
  ctx.effect(() => async () => {
    // Tool execution reports installation failures; disposal only waits for filesystem work to settle.
    await installation?.catch(() => undefined)
  })
  ctx.tools.register(defineTool({
    name: 'load_workspace_dependencies',
    description: 'Get absolute paths to bundled Python, Node.js, pnpm, and library directories. Python includes numpy and pandas. Run pnpm with the returned Node executable and pnpm script path. This does not change PATH or package-manager settings.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          python: { type: 'string', required: true },
          node: { type: 'string', required: true },
          pnpm: { type: 'string', required: true },
          pythonPackages: { type: 'string', required: true },
          nodePackages: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    execute: () => {
      installation ??= installPrimaryRuntime(config.source, config.root).catch((error: unknown) => {
        installation = undefined
        throw error
      })
      return installation
    },
    presentCall: () => ({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' }),
  }))
}
