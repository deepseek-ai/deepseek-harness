/**
 * REAL-composition tier (packages/AGENTS.md): boot the examples-owned
 * tool-pwsh Loader fixture as a subprocess through the same app/boot path a
 * deployment uses, execute real foreground and background pwsh commands
 * through the tool registry, and assert the assembled model-visible surface:
 * schema, prompt section, and rendered results. Self-skips when no `pwsh`
 * executable exists (a CI accommodation for hosts without PowerShell).
 */

import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

// The probe follows the executor's own resolution (Program Files installs on
// Windows are found even when bare `pwsh` is not on PATH).
const hasPwsh = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

const driver = fileURLToPath(new URL(
  './fixtures/loader/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  './fixtures/loader/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface PwshLoaderReport {
  schemaHasRunInBackground: boolean
  promptHasMarkerSection: boolean
  foregroundText: string
  foregroundCwd: string
  foregroundMeta: { cwd: string }
  backgroundText: string
  backgroundCwd: string
  backgroundMeta: { cwd: string }
}

describe.skipIf(!hasPwsh)('tool-pwsh through a real Loader composition', () => {
  // Self-hosted Windows runners reach ~40s for this smoke under the full
  // coverage load (measured on the 192-thread CI pool), against the
  // 30s default process deadline. Give the subprocess headroom so the
  // assembled boot completes instead of being SIGKILLed mid-load.
  const processTimeoutMs = 90_000
  it('registers the pwsh surface and renders real foreground and background results', async () => {
    let report: PwshLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'tool-pwsh loader smoke',
      tempDirPrefix: 'tool-pwsh-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'pwsh-loader-report.json'), 'utf8')) as PwshLoaderReport
        const expectedCwd = await realpath(cwd)
        expect(await realpath(report.foregroundCwd)).toBe(expectedCwd)
        expect(report.foregroundMeta).toEqual({ cwd: report.foregroundCwd })
        expect(await realpath(report.backgroundCwd)).toBe(expectedCwd)
        expect(report.backgroundMeta).toEqual({ cwd: report.backgroundCwd })
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      schemaHasRunInBackground: true,
      promptHasMarkerSection: true,
    })
    expect(report?.foregroundText).toBe('loader-ok\n')
    expect(report?.backgroundText).toContain('loader-bg-ok')
    expect(report?.backgroundText).toContain('[status: completed, exit code: 0]')
    // 15s of vitest headroom past the subprocess deadline, mirroring
    // LOADER_SMOKE_TEST_TIMEOUT_MS's margin over its process window.
  }, processTimeoutMs + 15_000)
})
