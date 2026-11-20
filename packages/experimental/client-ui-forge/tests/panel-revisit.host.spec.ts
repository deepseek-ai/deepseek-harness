/** A Session panel that starts again after its last follower left, the revisit of a followed one, and sign-in after a refused read. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ForgeReadiness } from '@deepseek-ai/dsh-experimental-forge'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Config, ForgePanelState } from '../src/index.ts'
import { bench, demo, follow, git, pullUrl, repository, scratch, shellTurn, snapshot } from './harness.ts'
import type { Bench, Follower } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal
const seven = { repository: demo, number: 7 }
const READY: ForgeReadiness = { state: 'ready', message: null, signIn: null }
const SIGNED_OUT: ForgeReadiness = { state: 'unauthenticated', message: 'sign in', signIn: null }
const UNSERVED = 'https://unserved.test/a/b/pull/3'

async function project(remote = 'https://fake.test/octo/demo.git'): Promise<{ root: string; repo: string }> {
  const { path, remove } = await scratch('dsh-forge-revisit-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', remote)
  return { root: path, repo }
}

/** A project on branch `feat` that tracks `origin/feat`, so an inspection finds an upstream branch to look up. */
async function tracking(): Promise<string> {
  const { repo } = await project()
  await git(repo, 'checkout', '-b', 'feat')
  await git(repo, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
  await git(repo, 'branch', '--set-upstream-to=origin/feat')
  return repo
}

async function open(cwd: string, config: Config = {}): Promise<Bench> {
  const opened = await bench(cwd, config)
  cleanups.push(() => opened.ctx.fiber.dispose())
  return opened
}

function reader(opened: Bench): Follower {
  const follower = follow(opened.ctx, opened.session)
  cleanups.push(follower.stop)
  return follower
}

const ready = (state: ForgePanelState): boolean => state.checkout.state === 'ready' && state.readiness !== null

/** Whether the change request at `url` holds a snapshot. */
function polled(state: ForgePanelState, url: string): boolean {
  return (state.changeRequests.find(entry => entry.url === url)?.snapshot ?? null) !== null
}

/** Whether the latest polling result of the change request at `url` is a failure. */
function failing(state: ForgePanelState, url: string): boolean {
  const update = state.changeRequests.find(entry => entry.url === url)?.update ?? null
  return update !== null && 'failure' in update
}

function commitOf(state: ForgePanelState | undefined): string | null {
  return state?.checkout.state === 'ready' ? state.checkout.checkout.commit : null
}

/** Wait for an inspection that starts after this call; the new commit gives it a state of its own to publish. */
async function inspectedAgain(repo: string, opened: Bench, follower: Follower, turn: number): Promise<void> {
  const before = commitOf(follower.states.at(-1))
  await git(repo, 'commit', '--allow-empty', '-m', `turn ${turn}`)
  shellTurn(opened.session, turn, [{ callId: `list-${turn}`, command: 'ls', output: '' }])
  await follower.next(state => commitOf(state) !== null && commitOf(state) !== before)
}

describe('forge panel that starts again', () => {
  it('publishes the state the last panel kept first, and neither probes sign-in nor looks the branch up again', async () => {
    const repo = await tracking()
    const opened = await open(repo)
    opened.provider.heads.set('feat', [7])
    const first = reader(opened)
    const left = await first.until(state => ready(state) && polled(state, pullUrl(7)))
    await first.stop()
    const fetched = opened.provider.fetches.length

    const second = reader(opened)
    const resumed = await second.until(() => true)

    // The registry kept no status once the last watcher left; the card shows the snapshot the panel kept.
    expect(resumed).toMatchObject({
      directory: repo, checkout: left.checkout, repository: demo, readiness: READY,
      changeRequests: [{ url: pullUrl(7), origin: 'discovered', update: null, snapshot: snapshot(seven) }],
    })
    await second.until(state => state.changeRequests[0]?.update != null)
    expect(opened.provider.fetches).toHaveLength(fetched + 1)
    // The first inspection of the new panel has ended once a later one publishes.
    await inspectedAgain(repo, opened, second, 1)
    expect(opened.provider.probes).toEqual(['fake.test'])
    expect(opened.provider.lookups).toEqual(['octo/demo feat'])
  })

  it('probes sign-in again when the last panel found the host signed out', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.provider.readinessImpl = () => Promise.resolve(SIGNED_OUT)
    const first = reader(opened)
    await first.until(state => state.readiness?.state === 'unauthenticated')
    await first.stop()
    opened.provider.readinessImpl = () => Promise.resolve(READY)

    const second = reader(opened)

    expect((await second.until(() => true)).readiness).toEqual(SIGNED_OUT)
    await second.until(state => state.readiness?.state === 'ready')
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])
  })

  it('probes sign-in again when the probe of the last panel had not answered', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const held = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = () => held.promise
    const first = reader(opened)
    await first.until(state => state.repository !== null)
    await first.stop()
    opened.provider.readinessImpl = () => Promise.resolve(READY)

    const second = reader(opened)

    expect(await second.until(() => true)).toMatchObject({ repository: demo, readiness: null })
    await second.until(state => state.readiness?.state === 'ready')
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])
    held.resolve(SIGNED_OUT)
  })

  it('starts without the kept state when the Session has moved to another directory', async () => {
    const { root, repo } = await project()
    const outside = join(root, 'plain')
    await mkdir(outside)
    const opened = await open(repo)
    const first = reader(opened)
    await first.until(ready)
    await first.stop()
    await opened.ctx.workingDirectory.set(opened.agent, outside)

    const second = reader(opened)

    expect(await second.until(() => true)).toMatchObject({ directory: outside, checkout: { state: 'pending' }, repository: null, readiness: null })
    await second.until(state => state.checkout.state === 'none')
  })

  it('looks the upstream branch up again while the Session shows no change request', async () => {
    const repo = await tracking()
    const opened = await open(repo)
    const first = reader(opened)
    await first.until(ready)
    await vi.waitFor(() => { expect(opened.provider.lookups).toEqual(['octo/demo feat']) })
    await first.stop()
    opened.provider.heads.set('feat', [7])

    const second = reader(opened)

    await second.until(state => polled(state, pullUrl(7)))
    expect(opened.provider.lookups).toEqual(['octo/demo feat', 'octo/demo feat'])
  })
})

describe('forge panel revisit', () => {
  it.each([
    ['polls a change request whose latest poll is older than statusMaxAgeMs', { statusMaxAgeMs: 1 }, 1],
    ['leaves a change request whose latest poll is younger than statusMaxAgeMs', {}, 0],
  ])('reinspects the checkout and %s, without a sign-in probe or a branch lookup', async (_, config, reads) => {
    const repo = await tracking()
    const opened = await open(repo, config)
    opened.provider.heads.set('feat', [7])
    const follower = reader(opened)
    const before = await follower.until(state => ready(state) && polled(state, pullUrl(7)))
    const fetched = opened.provider.fetches.length
    await new Promise(resolve => setTimeout(resolve, 5))
    await git(repo, 'commit', '--allow-empty', '-m', 'again')

    await opened.ctx.forgePanel.revisit(opened.session.id, signal)
    // A revisit names its Session by id and leaves the panels of other Sessions alone.
    await opened.ctx.forgePanel.revisit(brandString<SessionId>('session-unfollowed'), signal)

    // The revisit ended with its inspection, which found the new commit.
    await follower.next(state => commitOf(state) !== null && commitOf(state) !== commitOf(before))
    expect(opened.provider.fetches).toHaveLength(fetched + reads)
    expect(opened.provider.probes).toEqual(['fake.test'])
    expect(opened.provider.lookups).toEqual(['octo/demo feat'])
  })

  it('probes sign-in again while the host is not ready, and not while a probe has not answered', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const held = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = () => held.promise
    const follower = reader(opened)
    await follower.until(state => state.repository !== null)

    await opened.ctx.forgePanel.revisit(opened.session.id, signal)
    expect(opened.provider.probes).toEqual(['fake.test'])

    held.resolve(SIGNED_OUT)
    await follower.until(state => state.readiness?.state === 'unauthenticated')
    opened.provider.readinessImpl = () => Promise.resolve(READY)
    await opened.ctx.forgePanel.revisit(opened.session.id, signal)

    await follower.until(state => state.readiness?.state === 'ready')
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])
  })

  it('looks the upstream branch up again while the Session shows no change request', async () => {
    const repo = await tracking()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)
    await vi.waitFor(() => { expect(opened.provider.lookups).toEqual(['octo/demo feat']) })
    opened.provider.heads.set('feat', [7])

    await opened.ctx.forgePanel.revisit(opened.session.id, signal)

    await follower.until(state => polled(state, pullUrl(7)))
    expect(opened.provider.lookups).toEqual(['octo/demo feat', 'octo/demo feat'])
  })

  it('polls no change request that no provider serves', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${UNSERVED}\n` }])
    const follower = reader(opened)
    await follower.until(ready)

    await opened.ctx.forgePanel.revisit(opened.session.id, signal)

    expect(follower.states.at(-1)?.changeRequests).toMatchObject([{ url: UNSERVED, ref: null }])
    expect(opened.provider.fetches).toEqual([])
  })

  it('rejects a cancelled request', async () => {
    const { repo } = await project()
    const opened = await open(repo)

    await expect(opened.ctx.forgePanel.revisit(opened.session.id, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
  })
})

describe('forge panel sign-in after a refused status read', () => {
  it('probes sign-in again when a status read on the host shown as ready is refused as unauthenticated', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)
    // The binding reaches the panel before its first poll, and an unserved one never has a reference.
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n${UNSERVED}\n` }])
    await follower.until(state => polled(state, pullUrl(7)))
    expect(opened.provider.probes).toEqual(['fake.test'])

    opened.provider.failures.set(7, { code: 'unauthenticated', message: 'gh auth login' })
    opened.provider.readinessImpl = () => Promise.resolve(SIGNED_OUT)
    opened.ctx.forge.refresh(seven)

    await follower.until(state => failing(state, pullUrl(7)) && state.readiness === null)
    await follower.until(state => state.readiness?.state === 'unauthenticated')
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])

    // A further refused read finds the host no longer shown as ready.
    opened.ctx.forge.refresh(seven)
    await follower.next(state => failing(state, pullUrl(7)))
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])
  })

  it('probes sign-in once while refused status reads follow one another, and again after a status read succeeded', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = reader(opened)
    await follower.until(state => ready(state) && polled(state, pullUrl(7)))
    const refusedOnce = async (): Promise<void> => {
      opened.provider.failures.set(7, { code: 'unauthenticated', message: 'gh auth login' })
      opened.ctx.forge.refresh(seven)
      await follower.next(state => failing(state, pullUrl(7)))
    }

    // The probe keeps answering that the host is ready, as for a token that lacks access to one repository.
    await refusedOnce()
    await follower.until(state => failing(state, pullUrl(7)) && state.readiness?.state === 'ready')
    await refusedOnce()
    expect(opened.provider.probes).toEqual(['fake.test', 'fake.test'])

    opened.provider.failures.delete(7)
    opened.ctx.forge.refresh(seven)
    await follower.next(state => !failing(state, pullUrl(7)))
    await refusedOnce()
    await vi.waitFor(() => { expect(opened.provider.probes).toEqual(['fake.test', 'fake.test', 'fake.test']) })
  })

  it.each([
    ['is refused for another reason', 'https://fake.test/octo/demo.git', { code: 'not-found', message: 'gone' }, 'fake.test'],
    ['is refused as unauthenticated on another host', 'https://other.test/octo/demo.git', { code: 'unauthenticated', message: 'gh auth login' }, 'other.test'],
  ] as const)('leaves sign-in alone when a status read %s', async (_, remote, failure, host) => {
    const { repo } = await project(remote)
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = reader(opened)
    await follower.until(state => ready(state) && polled(state, pullUrl(7)))

    opened.provider.failures.set(7, failure)
    opened.ctx.forge.refresh(seven)

    const refused = await follower.until(state => failing(state, pullUrl(7)))
    expect(refused.readiness).toEqual(READY)
    expect(opened.provider.probes).toEqual([host])
  })
})
