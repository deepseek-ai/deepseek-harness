import { Context, Service } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeCommandRule } from '@deepseek-ai/dsh-experimental-forge-session'
import { afterEach, describe, expect, it } from 'vitest'
import { GLAB_COMMANDS } from '../src/commands.ts'
import * as ForgeGitLab from '../src/index.ts'

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

describe('forge-gitlab plugin', () => {
  it('registers the GitLab provider for the configured hosts', async () => {
    const context = await forge()
    await context.plugin(ForgeGitLab, { hosts: ['gitlab.com', 'GitLab.Example.test'] })

    expect(context.forge.changeRequestFromUrl('https://gitlab.example.test/group/sub/app/-/merge_requests/6')).toEqual({
      repository: { forge: 'gitlab', host: 'gitlab.example.test', owner: 'group/sub', name: 'app' },
      number: 6,
    })
    expect(context.forge.describe('gitlab')).toEqual({ forge: 'gitlab', label: 'GitLab', changeRequestNoun: 'merge-request' })
  })

  it('serves gitlab.com by default', async () => {
    const context = await forge()
    await context.plugin(ForgeGitLab, {})

    expect(context.forge.repositoryFromRemote('git@gitlab.com:group/app.git')).toEqual({ forge: 'gitlab', host: 'gitlab.com', owner: 'group', name: 'app' })
    expect(context.forge.repositoryFromRemote('git@gitlab.example.test:group/app.git')).toBeUndefined()
  })

  it('registers the glab commands with forge-session while both run', async () => {
    const context = await forge()
    await context.plugin(RecordingForgeSession)
    const fiber = context.plugin(ForgeGitLab, {})
    await fiber

    expect([...registered]).toEqual([GLAB_COMMANDS])
    await fiber.dispose()
    expect(registered.size).toBe(0)
  })

  it('unregisters the provider when its fiber is disposed', async () => {
    const context = await forge()
    const fiber = context.plugin(ForgeGitLab, {})
    await fiber

    await fiber.dispose()

    expect(context.forge.changeRequestFromUrl('https://gitlab.com/group/app/-/merge_requests/1')).toBeUndefined()
  })

  it.each([
    [{ glabCommand: '  ' }, 'forge-gitlab: glabCommand must not be empty'],
    [{ hosts: [] }, 'forge-gitlab: hosts must list at least one host'],
    [{ hosts: ['https://gitlab.com'] }, 'forge-gitlab: invalid host "https://gitlab.com"'],
    [{ timeoutMs: 0 }, 'forge-gitlab: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ timeoutMs: 2_147_483_648 }, 'forge-gitlab: timeoutMs must be a positive integer no greater than 2147483647'],
    [{ maxOutputBytes: 0 }, 'forge-gitlab: maxOutputBytes must be a positive safe integer'],
    [{ maxReviewThreads: 1.5 }, 'forge-gitlab: maxReviewThreads must be a positive safe integer'],
    [{ maxCommits: 0 }, 'forge-gitlab: maxCommits must be a positive safe integer'],
    [{ statusBatchSize: 0 }, 'forge-gitlab: statusBatchSize must be a positive safe integer'],
    [{ maxConcurrentRequests: -1 }, 'forge-gitlab: maxConcurrentRequests must be a positive safe integer'],
    [{ maxCachedVersionBytes: Number.MAX_SAFE_INTEGER + 1 }, 'forge-gitlab: maxCachedVersionBytes must be a positive safe integer'],
  ])('refuses the configuration %j', async (config, message) => {
    const context = await forge()
    await expect(context.plugin(ForgeGitLab, config)).rejects.toThrow(message)
  })

  it('refuses a host the GitHub provider already serves', async () => {
    const context = await forge()
    context.forge.register({ ...stubProvider(), hosts: ['code.example.test'] })

    await expect(context.plugin(ForgeGitLab, { hosts: ['code.example.test'] }))
      .rejects.toThrow('forge: host "code.example.test" is already served by the "github" provider')
  })
})

/** A provider of the `github` family that serves nothing it is asked. */
function stubProvider(): Parameters<Context['forge']['register']>[0] {
  const never = (): never => { throw new Error('not called') }
  return {
    forge: 'github', hosts: [], label: 'GitHub', changeRequestNoun: 'pull-request',
    repositoryFromRemote: () => undefined, changeRequestFromUrl: () => undefined, changeRequestUrl: never, fetch: never,
    findByHead: never, readiness: never, markReady: never, merge: never, diff: never, fileText: never, fileUrl: never,
  }
}
