import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeCommandRule } from '@deepseek-ai/dsh-experimental-forge-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GLAB_COMMANDS } from '../src/commands.ts'
import * as ForgeGitLab from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { HOST, merge } from './fixtures.ts'
import { mergeRequestNode } from './status.spec.ts'

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
    [{ hosts: [] }, '$.hosts expected array length >= 1 but got 0'],
    [{ hosts: ['https://gitlab.com'] }, '$.hosts[0] expect string to match regexp'],
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

  it('serves the host list a live edit sets without mounting again', async () => {
    const context = await forge()
    const live = await liveConfig(context, ForgeGitLab)
    expect(context.forge.repositoryFromRemote('git@gitlab.example.test:group/app.git')).toBeUndefined()

    await live.update({ hosts: ['gitlab.com', 'gitlab.example.test'] })

    expect(context.forge.repositoryFromRemote('git@gitlab.example.test:group/app.git')).toEqual({ forge: 'gitlab', host: 'gitlab.example.test', owner: 'group', name: 'app' })
    expect(context.forge.repositoryFromRemote('git@gitlab.com:group/app.git')).toBeDefined()
    // Identity only: printing a Fiber walks Context proxies.
    expect(Object.is(live.entry.fiber, live.fiber)).toBe(true)

    await live.update({ hosts: ['gitlab.com'] })
    expect(context.forge.repositoryFromRemote('git@gitlab.example.test:group/app.git')).toBeUndefined()
  })

  it('keeps serving its previous hosts when a live edit adds one another provider serves', async () => {
    const context = await forge()
    context.forge.register({ ...otherProvider(), hosts: ['code.example.test'] })
    const live = await liveConfig(context, ForgeGitLab)
    const warned = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})

    await live.update({ hosts: ['gitlab.com', 'code.example.test'] })

    expect(context.forge.repositoryFromRemote('git@gitlab.com:group/app.git')).toMatchObject({ forge: 'gitlab', host: 'gitlab.com' })
    expect(context.forge.changeRequestFromUrl('https://code.example.test/group/app/-/merge_requests/1')).toBeUndefined()
    expect(warned.mock.calls.map((call): unknown => call[0]))
      .toContainEqual(new Error('forge: host "code.example.test" is already served by the "github" provider'))
  })

  it('keeps its own instance off the generated Settings pages', async () => {
    await omitsGeneratedPage(async (context) => {
      await context.plugin(ForgeService)
      return context.plugin(ForgeGitLab, {})
    })
  })

  it('refuses a host the GitHub provider already serves', async () => {
    const context = await forge()
    context.forge.register({ ...otherProvider(), hosts: ['code.example.test'] })

    await expect(context.plugin(ForgeGitLab, { hosts: ['code.example.test'] }))
      .rejects.toThrow('forge: host "code.example.test" is already served by the "github" provider')
  })
})

/** A provider of the `github` family that serves nothing it is asked. */
function otherProvider(): Parameters<Context['forge']['register']>[0] {
  const never = (): never => { throw new Error('not called') }
  return {
    forge: 'github', hosts: [], label: 'GitHub', changeRequestNoun: 'pull-request',
    repositoryFromRemote: () => undefined, changeRequestFromUrl: () => undefined, changeRequestUrl: never, fetch: never,
    findByHead: never, readiness: never, markReady: never, merge: never, diff: never, fileText: never, fileUrl: never,
  }
}

// The recording `glab` starts through a POSIX shell script.
describe.skipIf(process.platform === 'win32')('forge-gitlab plugin status queries', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  /**
   * A `glab` that appends the merge request numbers of each status query to a log and answers a mergeable merge request
   * for each; every other request answers an empty list.
   */
  async function recordingGlab(): Promise<{ readonly command: string; readonly queries: () => Promise<string[][]> }> {
    const root = await mkdtemp(join(tmpdir(), 'forge-gitlab-status-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const log = join(root, 'queries.log')
    const script = join(root, 'glab.mjs')
    await writeFile(script, [
      'import { appendFileSync, readFileSync } from \'node:fs\'',
      'if (!process.argv.includes(\'graphql\')) { process.stdout.write(\'[]\'); process.exit(0) }',
      'const { variables } = JSON.parse(readFileSync(0, \'utf8\'))',
      'const numbers = Object.keys(variables).filter(name => /^i\\d+$/.test(name)).map(name => variables[name])',
      `appendFileSync(${JSON.stringify(log)}, numbers.join(' ') + '\\n')`,
      `const project = ${JSON.stringify({ mergeRequestsFfOnlyEnabled: false, mergeRequest: mergeRequestNode() })}`,
      'process.stdout.write(JSON.stringify({ data: Object.fromEntries(numbers.map((_number, index) => [\'m\' + index, project])) }))',
      '',
    ].join('\n'))
    const command = join(root, 'glab')
    await writeFile(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
    await chmod(command, 0o755)
    return { command, queries: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(' ')) }
  }

  it.each([
    ['one merge request each by default', {}, [['1'], ['2'], ['3']]],
    ['the configured number of merge requests', { statusBatchSize: 2 }, [['1', '2'], ['3']]],
  ])('polls the watches of the forge service in status queries of %s', async (_label, config, batches) => {
    const glab = await recordingGlab()
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    await context.plugin(ForgeService)
    await context.plugin(ForgeGitLab, { glabCommand: glab.command, hosts: [HOST], ...config })
    const mergeable = new Map<number, boolean>()

    for (const number of [1, 2, 3]) {
      context.forge.watch(merge(number), (update) => { if ('snapshot' in update) mergeable.set(number, update.snapshot.mergeReady) })
    }

    await vi.waitFor(() => { expect(mergeable.size).toBe(3) }, { timeout: 10_000 })
    expect([...mergeable.values()]).toEqual([true, true, true])
    // The queries of one poll run side by side, so their order in the log varies.
    expect((await glab.queries()).sort((left, right) => left[0]!.localeCompare(right[0]!))).toEqual(batches)
  })
})
