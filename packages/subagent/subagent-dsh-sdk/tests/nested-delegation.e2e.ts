/** A full child profile must finish its nested fork before its external task settles. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { createProcessDeepSeekHarness } from '../../../sdk/client/src/api.ts'
import { spawnSubprocess } from '../../../subprocess/subprocess-local/src/spawn.ts'
import { startAcpRun } from '../../subagent-acp/src/run.ts'
import { externalTestParent } from '../../subagent/tests/external-activation-helpers.ts'
import { internals, startSdkRun } from '../src/run.ts'

const sourceBin = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/loader/nested-mock-llm.ts', import.meta.url))

describe('external tasks with a nested fork', () => {
  it.each([
    ['sdk', 'complete'], ['acp', 'complete'], ['sdk', 'cancel'], ['acp', 'cancel'],
    ['sdk', 'error'], ['acp', 'error'],
  ] as const)('%s owns the nested task through %s', { timeout: 60_000, retry: 0 }, async (profile, outcome) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-${profile}-nested-`))
    const ctx = new Context()
    const originalFactory = internals.createHarness.bind(internals)
    const release = join(root, 'release')
    const ready = join(root, 'ready')
    const idle = join(root, 'idle')
    const patch = join(root, 'nested.patch.yml')
    const env = {
      DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1',
      DSH_TEST_CHILD_READY: ready, DSH_TEST_CHILD_RELEASE: release, DSH_TEST_ROOT_IDLE: idle,
      DSH_TEST_SUMMARY_ERROR: outcome === 'error' ? '1' : '0',
    }
    const launch = resolveExampleLaunch({
      srcBin: sourceBin, tsconfigPath: tsconfig, sourceImport: 'tsx/esm',
      configArgs: ['--profile', profile, '--patch', patch], env,
    })
    let run: Awaited<ReturnType<typeof startSdkRun>> | undefined
    try {
      await writeFile(patch, JSON.stringify([
        { id: 'llm-deepseek', disabled: true },
        { id: 'agent-instructions', disabled: true },
        { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
        { id: 'typert-loader', disabled: true },
        ...profile === 'acp' ? [{ id: 'acp', config: { provider: 'mock', model: 'mock' } }] : [],
        { insert: [{ id: 'nested-mock-llm', name: fixture }] },
      ]))
      const parent = await externalTestParent(ctx, root)
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
      const request = { parent, prompt: [{ type: 'text' as const, text: 'delegate with a fork' }], signal }
      if (profile === 'sdk') {
        internals.createHarness = options => createProcessDeepSeekHarness({
          command: launch.command, args: launch.args, cwd: root,
          environment: () => ({ ...process.env, ...launch.env }),
          description: 'nested SDK profile', initializeTimeoutMs: 30_000,
        }, options)
        run = await startSdkRun(request, {
          profile, patches: [patch], dshHome: env.DSH_HOME, cwd: root, provider: 'mock', model: 'mock', env,
          shutdownTimeoutMs: 1_000, disposeEofGraceMs: 6_000, disposeGraceMs: 3_000,
        })
      } else {
        run = await startAcpRun(request, {
          command: launch.command, args: launch.args, cwd: root, permission: 'reject',
          env: Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          disposeEofGraceMs: 6_000, disposeGraceMs: 3_000, spawn: spec => spawnSubprocess(spec),
        })
      }
      let settled = false
      void run.result.then(() => { settled = true })
      await vi.waitFor(() => { expect(existsSync(ready) && existsSync(idle)).toBe(true) }, { timeout: 30_000 })
      expect(settled).toBe(false)
      if (outcome === 'cancel') {
        controller.abort()
        expect((await run.result).stopReason).toBe('aborted')
        return
      }
      await writeFile(release, 'release\n')
      const result = await run.result
      if (outcome === 'error') {
        expect(result.stopReason).toBe('error')
        return
      }
      expect(result.stopReason).toBe('completed')
      const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('parent summary after child')
    } finally {
      await writeFile(release, 'release\n')
      await run?.dispose()
      internals.createHarness = originalFactory
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
