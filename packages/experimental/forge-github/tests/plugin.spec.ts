import { Context, Service } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeCommandRule } from '@deepseek-ai/dsh-experimental-forge-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GH_COMMANDS } from '../src/commands.ts'
import * as ForgeGitHub from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'

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

  it('offers the three viewer lists on its hosts, 50 pull requests per read by default', async () => {
    const context = await forge()
    await context.plugin(ForgeGitHub, { hosts: ['github.com', 'ghe.corp.example'] })

    expect(context.forge.viewerSources()).toEqual([{
      forge: 'github', hosts: ['github.com', 'ghe.corp.example'], filters: new Set(['review-requested', 'authored', 'involved']), maxItems: 50,
    }])
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
    [{ hosts: [] }, '$.hosts expected array length >= 1 but got 0'],
    [{ hosts: ['https://github.com'] }, '$.hosts[0] expect string to match regexp'],
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
    [{ maxViewerItems: 0 }, 'forge-github: maxViewerItems must be a positive safe integer'],
    [{ maxViewerItems: 101 }, 'forge-github: maxViewerItems must be no greater than 100'],
  ])('rejects %j at load', async (config, message) => {
    const context = await forge()

    await expect(context.plugin(ForgeGitHub, config)).rejects.toThrow(message)
  })

  it('serves the host list a live edit sets without mounting again', async () => {
    const context = await forge()
    const live = await liveConfig(context, ForgeGitHub)
    expect(context.forge.repositoryFromRemote('https://ghe.corp.example/team/svc.git')).toBeUndefined()

    await live.update({ hosts: ['github.com', 'ghe.corp.example'] })

    expect(context.forge.repositoryFromRemote('https://ghe.corp.example/team/svc.git')).toEqual({ forge: 'github', host: 'ghe.corp.example', owner: 'team', name: 'svc' })
    expect(context.forge.repositoryFromRemote('https://github.com/octo/demo.git')).toBeDefined()
    // Identity only: printing a Fiber walks Context proxies.
    expect(Object.is(live.entry.fiber, live.fiber)).toBe(true)

    await live.update({ hosts: ['github.com'] })
    expect(context.forge.repositoryFromRemote('https://ghe.corp.example/team/svc.git')).toBeUndefined()
  })

  it('keeps serving its previous hosts when a live edit adds one another provider serves', async () => {
    const context = await forge()
    context.forge.register({ ...otherProvider(), hosts: ['code.example.test'] })
    const live = await liveConfig(context, ForgeGitHub)
    const warned = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})

    await live.update({ hosts: ['github.com', 'code.example.test'] })

    expect(context.forge.repositoryFromRemote('https://github.com/octo/demo.git')).toMatchObject({ forge: 'github', host: 'github.com' })
    expect(context.forge.changeRequestFromUrl('https://code.example.test/octo/demo/pull/1')).toBeUndefined()
    expect(warned.mock.calls.map((call): unknown => call[0]))
      .toContainEqual(new Error('forge: host "code.example.test" is already served by the "gitlab" provider'))
  })

  it('keeps its own instance off the generated Settings pages', async () => {
    await omitsGeneratedPage(async (context) => {
      await context.plugin(ForgeService)
      return context.plugin(ForgeGitHub, {})
    })
  })

  it('does not apply timer limits to the output byte budget', async () => {
    const context = await forge()
    await context.plugin(ForgeGitHub, { maxOutputBytes: 2_147_483_648 })
    expect(context.forge.repositoryFromRemote('https://github.com/octo/demo.git')).toBeDefined()
  })
})

/** A provider of the `gitlab` family that serves nothing it is asked. */
function otherProvider(): Parameters<Context['forge']['register']>[0] {
  const never = (): never => { throw new Error('not called') }
  return {
    forge: 'gitlab', hosts: [], label: 'GitLab', changeRequestNoun: 'merge-request',
    repositoryFromRemote: () => undefined, changeRequestFromUrl: () => undefined, changeRequestUrl: never, fetch: never,
    findByHead: never, readiness: never, markReady: never, merge: never, diff: never, fileText: never, fileUrl: never,
  }
}
