/**
 * Local-filesystem implementation of `ctx.fileReferences`.
 *
 * @module @deepseek-ai/dsh-file-reference-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, {
  FILE_REFERENCE_PROMPT,
  type FileReferenceCandidate,
} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
  type FileSearchConfig,
} from './search.ts'

export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from './search.ts'
export type { FileSearchConfig } from './search.ts'
export { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** Local file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[]
}

/** Local-filesystem owner of the file-reference discovery service. */
export class LocalFileReferenceService extends FileReferenceService {
  static inject = ['agents']
  static Config: z<Config> = z.object({
    maxResults: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS),
    maxEntries: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES),
    excludedDirectories: z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES]),
  })

  private readonly config: FileSearchConfig
  private readonly searches = new Map<Agent, WorkspaceFileSearch>()
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  private readonly promptDisposals = new Set<Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = {
      maxResults: config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }
    validateConfig(this.config)

    const installPrompt = (agent: Agent): ReturnType<Context['inject']> => {
      const existing = this.promptFibers.get(agent)
      if (existing !== undefined) return existing
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
        scope.systemPrompt.section({
          name: 'context:file-reference',
          order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
          text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
        })
      })
      this.promptFibers.set(agent, fiber)
      return fiber
    }
    const disposePrompt = (agent: Agent): void => {
      const fiber = this.promptFibers.get(agent)
      if (fiber === undefined) return
      this.promptFibers.delete(agent)
      const task = fiber.dispose().catch((error: unknown) => {
        ctx.logger.warn(`file-reference-local: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.promptDisposals.add(task)
      void task.finally(() => {
        this.promptDisposals.delete(task)
      })
    }
    for (const agent of ctx.agents.list()) installPrompt(agent)
    ctx.on('agent/created', async ({ agent }) => { await installPrompt(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      this.searches.get(agent)?.dispose()
      this.searches.delete(agent)
      disposePrompt(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) this.searches.get(agent)?.invalidate()
    })
    ctx.effect(() => async () => {
      for (const search of this.searches.values()) search.dispose()
      this.searches.clear()
      const promptFibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all([
        ...promptFibers.map(fiber => fiber.dispose()),
        ...this.promptDisposals,
      ])
    }, 'file-reference-local: search cache')
  }

  override list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    let search = this.searches.get(agent)
    if (search === undefined) {
      search = new WorkspaceFileSearch(agent.session.header.cwd ?? process.cwd(), this.config)
      this.searches.set(agent, search)
    }
    return search.list(query, signal)
  }
}

function validateConfig(config: FileSearchConfig): void {
  if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
    throw new Error('file-reference-local: maxResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
    throw new Error('file-reference-local: maxEntries must be a positive safe integer')
  }
  if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
    throw new Error('file-reference-local: excludedDirectories entries must be non-empty directory basenames')
  }
}

export default LocalFileReferenceService
