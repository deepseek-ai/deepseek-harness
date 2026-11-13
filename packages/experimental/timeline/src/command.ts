import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import { CHECKPOINT_BYTES } from './checkpoint.ts'
import type { TimelineStorage } from './storage.ts'

const usage =
  'Use /timeline @plan.timeline.json [--continue] [--copy]. Quote paths with spaces: @"my plan.timeline.json".'

/**
 * Register a human command; importing needs no model or new agent tool.
 * @param ctx - owning plugin context.
 * @param storage - Timeline's session data service.
 */
export function installCommand(ctx: Context, storage: TimelineStorage): void {
  ctx.inject(['commands'], (scope) => {
    scope.effect(
      () =>
        scope.commands.register({
          name: 'timeline',
          description: 'Open Timeline or import a task-tree checkpoint',
          input: { hint: '@checkpoint.timeline.json [--continue] [--copy]' },
          handler: async ({ agent, rawInput, commandId, signal }) => {
            if (!rawInput.trim()) return { kind: 'success', text: usage }
            const input = rawInput.trim()
            const match = /^@(?:"[^"\r\n]+"|[^\s"]+)(?=\s|$)/u.exec(input)
            if (match === null) return { kind: 'error', text: usage }
            const reference = match[0]
            const path = reference.startsWith('@"') ? reference.slice(2, -1) : reference.slice(1)
            const options = input.slice(reference.length).trim().split(/\s+/u).filter(Boolean)
            if (options.some(flag => flag !== '--continue' && flag !== '--copy') || new Set(options).size !== options.length)
              return { kind: 'error', text: usage }
            if (agent.status !== 'idle')
              return {
                kind: 'error',
                text: 'Wait for the current turn to finish, or stop it before importing a task tree.',
              }
            const fs = agent.ctx.get('fs')
            if (fs === undefined)
              return {
                kind: 'error',
                text: 'The filesystem is unavailable. Import the checkpoint with the Timeline file picker.',
              }
            try {
              const target = await fs.resolve(path, {
                ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
                signal,
              })
              const bytes = await fs.readBytes(target, signal, CHECKPOINT_BYTES)
              const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
              signal.throwIfAborted()
              const result = await storage.edit({
                action: 'import',
                sessionId: agent.session.id,
                id: commandId,
                content,
                copy: options.includes('--copy'),
                continue: options.includes('--continue'),
              })
              if (result.action !== 'import') throw new Error('Invalid Timeline import response')
              const continued = options.includes('--continue')
                ? result.notified
                  ? ' Continuation requested.'
                  : ' Check the conversation before requesting continuation again.'
                : ''
              return {
                kind: 'success',
                text: `${result.reused ? 'Opened the existing copy' : 'Imported the task tree'} (${result.tree}).${continued}`,
              }
            } catch (error: unknown) {
              return {
                kind: 'error',
                text: error instanceof Error ? error.message : 'Timeline import failed',
              }
            }
          },
        }),
      'timeline: checkpoint command',
    )
  })
}
