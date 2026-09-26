/** Waiting for one run's tree is decided by platform and target, without starting a real process. */
import { expect, it } from 'vitest'
import { awaitTreeGone, leadsOwnGroup, type RunTree } from '../src/run-tree.ts'

/** One run's process or process group. */
function tree(pid: number | undefined, grouped = true): RunTree {
  return { pid, grouped }
}

it.each([
  ['service', 'linux', true],
  ['service', 'darwin', true],
  ['service', 'win32', false],
  ['cli', 'linux', false],
  ['cli', 'win32', false],
] as const)('decides group leadership for %s on %s', (execution, platform, expected) => {
  expect(leadsOwnGroup(execution, platform)).toBe(expected)
})

it('waits for a tree that disappears on its own', async () => {
  let alive = true
  await expect(awaitTreeGone(tree(42), {
    platform: 'linux',
    alive: () => { const first = alive; alive = false; return first },
  })).resolves.toBeUndefined()
})

it('probes the group a run leads and the process it does not', async () => {
  const probes: number[] = []
  const gone = { alive: (target: number) => { probes.push(target); return false } }
  await expect(awaitTreeGone(tree(42), { ...gone, platform: 'linux' })).resolves.toBeUndefined()
  await expect(awaitTreeGone(tree(42, false), { ...gone, platform: 'linux' })).resolves.toBeUndefined()
  await expect(awaitTreeGone(tree(42), { ...gone, platform: 'win32' })).resolves.toBeUndefined()
  expect(probes).toEqual([-42, 42, 42])
})

it('returns at once for a tree with no process id or one already gone', async () => {
  await expect(awaitTreeGone(tree(undefined), { alive: () => { throw new Error('never probed') } })).resolves.toBeUndefined()
  // The host platform answers for a run that names none, and the default probe reports a vanished process.
  await expect(awaitTreeGone(tree(99_999_999, false))).resolves.toBeUndefined()
  await expect(awaitTreeGone(tree(99_999_999, false), { platform: 'linux' })).resolves.toBeUndefined()
})

it('gives up on a tree that never disappears', async () => {
  // The wait bound is an input, so this needs no global clock: fake timers leak into the suites sharing the worker.
  await expect(awaitTreeGone(tree(42), { platform: 'linux', alive: () => true, waitMs: 0 })).resolves.toBeUndefined()
})
