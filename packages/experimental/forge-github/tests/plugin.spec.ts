import { Context, Service } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeCommandRule } from '@deepseek-ai/dsh-experimental-forge-session'
import { afterEach, describe, expect, it } from 'vitest'
import { GH_COMMANDS } from '../src/commands.ts'
import * as ForgeGitHub from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Command rules registered with {@link RecordingForgeSession} whose registering fiber is live. */
const registered = new Set<ForgeCommandRule>()

/** A `forgeSession` service that records command rule registrations in {@link registered}. */
class RecordingForgeSession extends Service {
  constructor(ctx: Context) {
    super(ctx, 'forgeSession')
  }

  registerCommands(rule: ForgeCommandRule): () => void {
    const dispose = this.ctx.effect(() => {
      registered.add(rule)
      return () => { registered.delete(rule) }
    })
    return () => void dispose()
  }
}

async function forge(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(ForgeService)
  return ctx
}

describe('forge-github plugin', () => {
  it('registers the GitHub provider for the configured hosts', async () => {
    const context = await forge()
    await context.plugin(ForgeGitHub, { hosts: ['github.com', 'ghe.corp.example'] })

    expect(context.forge.changeRequestFromUrl('https://github.com/octo/demo/pull/1')).toEqual({
      repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' },
      number: 1,
    })
    expect(context.forge.repositoryFromRemote('git@ghe.corp.example:team/svc.git')).toEqual({ forge: 'github', host: 'ghe.corp.example', owner: 'team', name: 'svc' })
  })

  it('serves github.com by default', async () => {
    const context = await forge()
    await context.plugin(ForgeGitHub, {})

    expect(context.forge.repositoryFromRemote('https://github.com/octo/demo.git')).toBeDefined()
    expect(context.forge.repositoryFromRemote('https://ghe.corp.example/team/svc.git')).toBeUndefined()
  })

  it('registers the gh commands with forge-session while both run', async () => {
    const context = await forge()
    await context.plugin(RecordingForgeSession)
    const fiber = context.plugin(ForgeGitHub, {})
    await fiber

    expect([...registered]).toEqual([GH_COMMANDS])
    await fiber.dispose()
    expect(registered.size).toBe(0)
  })

  it('unregisters the provider when its fiber is disposed', async () => {
    const context = await forge()
    const fiber = context.plugin(ForgeGitHub, {})
    await fiber

    await fiber.dispose()

    expect(context.forge.changeRequestFromUrl('https://github.com/octo/demo/pull/1')).toBeUndefined()
  })

  it.each([
    [{ ghCommand: '  ' }, 'forge-github: ghCommand must not be empty'],
    [{ hosts: [] }, 'forge-github: hosts must list at least one host'],
    [{ hosts: ['https://github.com'] }, 'forge-github: invalid host "https://github.com"'],
    [{ timeoutMs: 0 }, 'forge-github: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ timeoutMs: 2_147_483_648 }, 'forge-github: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ timeoutMs: 1.5 }, 'forge-github: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ maxOutputBytes: 1.5 }, 'forge-github: maxOutputBytes must be a positive safe integer'],
    [{ maxOutputBytes: 0 }, 'forge-github: maxOutputBytes must be a positive safe integer'],
    [{ maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 }, 'forge-github: maxOutputBytes must be a positive safe integer'],
    [{ maxCommits: 0 }, 'forge-github: maxCommits must be a positive safe integer'],
    [{ maxCommits: 2.5 }, 'forge-github: maxCommits must be a positive safe integer'],
    [{ maxReviewThreads: 0 }, 'forge-github: maxReviewThreads must be a positive safe integer'],
    [{ maxReviewThreads: 2.5 }, 'forge-github: maxReviewThreads must be a positive safe integer'],
  ])('rejects %j at load', async (config, message) => {
    const context = await forge()

    await expect(context.plugin(ForgeGitHub, config)).rejects.toThrow(message)
  })

  it('does not apply timer limits to the output byte budget', async () => {
    const context = await forge()
    await context.plugin(ForgeGitHub, { maxOutputBytes: 2_147_483_648 })
    expect(context.forge.repositoryFromRemote('https://github.com/octo/demo.git')).toBeDefined()
  })
})
