import { Context, Service } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeCommandRule } from '@deepseek-ai/dsh-experimental-forge-session'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GH_COMMANDS } from '../src/commands.ts'
import * as ForgeGitHub from '../src/index.ts'
import { briefNode, pull, pullRequestNode } from './fixtures.ts'
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
    [{ snapshotBatchSize: 0 }, 'forge-github: snapshotBatchSize must be a positive safe integer'],
    [{ snapshotBatchSize: 2.5 }, 'forge-github: snapshotBatchSize must be a positive safe integer'],
    [{ maxCommits: 0 }, 'forge-github: maxCommits must be a positive safe integer'],
    [{ maxCommits: 2.5 }, 'forge-github: maxCommits must be a positive safe integer'],
    [{ maxReviewThreads: 0 }, 'forge-github: maxReviewThreads must be a positive safe integer'],
    [{ maxReviewThreads: 2.5 }, 'forge-github: maxReviewThreads must be a positive safe integer'],
    [{ briefBatchSize: 0 }, 'forge-github: briefBatchSize must be a positive safe integer'],
    [{ briefBatchSize: 2.5 }, 'forge-github: briefBatchSize must be a positive safe integer'],
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

// The recording `gh` is a POSIX shell script, as in gh.spec.ts.
describe.skipIf(process.platform === 'win32')('forge-github plugin status queries', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  /**
   * A `gh` that appends the pull request numbers of each query to a log and answers `node` for each; a query that
   * names pull request `hangOn` never answers.
   */
  async function recordingGh(
    node: Record<string, unknown>, hangOn?: number,
  ): Promise<{ readonly command: string; readonly queries: () => Promise<number[][]> }> {
    const root = await mkdtemp(join(tmpdir(), 'forge-github-status-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const command = join(root, 'gh')
    const log = join(root, 'queries.log')
    await writeFile(command, [
      '#!/bin/sh',
      'numbers=$(printf "%s" "$*" | grep -o "pullRequest(number: [0-9]*)" | grep -o "[0-9]*" | tr "\\n" " ")',
      `printf "%s\\n" "$numbers" >> ${JSON.stringify(log)}`,
      ...hangOn === undefined ? [] : [`case " $numbers" in *" ${hangOn} "*) exec sleep 60;; esac`],
      'fields=""; index=0',
      `for number in $numbers; do fields="$fields\${fields:+,}\\"p$index\\":"${JSON.stringify(JSON.stringify(node))}; index=$((index + 1)); done`,
      'printf "{\\"data\\":{\\"r0\\":{%s}}}" "$fields"',
      '',
    ].join('\n'))
    await chmod(command, 0o755)
    return {
      command,
      queries: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => line.trim().split(' ').map(Number)),
    }
  }

  it.each([
    ['brief', {}, 51, [25, 25, 1]],
    ['brief', { briefBatchSize: 3 }, 4, [3, 1]],
    ['snapshot', {}, 9, [8, 1]],
    ['snapshot', { snapshotBatchSize: 3 }, 4, [3, 1]],
  ] as const)('polls %s watches of the forge service in queries of the configured size: %j', async (level, config, count, sizes) => {
    const gh = await recordingGh(level === 'brief' ? briefNode(0) : pullRequestNode(0))
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    await context.plugin(ForgeService)
    await context.plugin(ForgeGitHub, { ghCommand: gh.command, ...config })
    const seen = new Set<ChangeRequestKey>()

    for (const ref of Array.from({ length: count }, (_, index) => pull(index + 1))) {
      if (level === 'brief') context.forge.watchBrief(ref, update => void ('brief' in update && seen.add(update.key)))
      else context.forge.watch(ref, update => void ('snapshot' in update && seen.add(update.key)))
    }

    await vi.waitFor(() => { expect(seen.size).toBe(count) }, { timeout: 10_000 })
    expect((await gh.queries()).map(numbers => numbers.length)).toEqual(sizes)
  })

  it('gives each query a fetch deadline of its own, so a query whose gh run hangs fails only its own pull requests', async () => {
    const gh = await recordingGh(pullRequestNode(0), 1)
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    // The deadline of the registry equals the one of a `gh` run, as it does by default. Five seconds leave the `gh`
    // run that answers enough time on a machine that also runs other specs.
    await context.plugin(ForgeService, { fetchTimeoutMs: 5_000 })
    await context.plugin(ForgeGitHub, { ghCommand: gh.command, timeoutMs: 5_000, snapshotBatchSize: 2 })
    const outcomes = new Map<number, string>()

    for (const number of [1, 2, 3, 4]) {
      context.forge.watch(pull(number), (update) => { outcomes.set(number, 'failure' in update ? update.failure.code : 'snapshot') })
    }

    await vi.waitFor(() => { expect(outcomes.size).toBe(4) }, { timeout: 30_000 })
    expect([...outcomes].sort(([left], [right]) => left - right)).toEqual([[1, 'unavailable'], [2, 'unavailable'], [3, 'snapshot'], [4, 'snapshot']])
    // The run that hangs may end before it logged its query; the query after it is sent once.
    expect((await gh.queries()).filter(numbers => !numbers.includes(1))).toEqual([[3, 4]])
  }, 60_000)
})
