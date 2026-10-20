/** Published CUA entries retain headless isolation and the existing generated transport. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it, onTestFinished } from 'vitest'

it('loads the built Host, object API and native exports without Client dependencies', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/exports.mjs', import.meta.url))
  const launch = resolveExampleLaunch({ srcBin: fixture, libBin: fixture, mode: 'lib' })
  const controller = new AbortController()
  const child = promisify(execFile)(launch.command, launch.args, { signal: controller.signal })
  onTestFinished(async () => {
    controller.abort()
    await child.catch(() => { /* A failed or cancelled fixture is asserted by the test. */ })
  })
  expect((await child).stdout).toBe('headless exports and generated Remote passed\n')
})
