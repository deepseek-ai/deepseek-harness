/** Built Desktop Host startup with incomplete or unusable Office resources; run after the repository build. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { desktopOfficeEnvironment } from '../src/office-cli.ts'
import { builtHost, prepareDesktopHome, repository } from './harness.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe.skipIf(!existsSync(builtHost))('built Desktop Host Office resources', () => {
  it.each([
    ['one missing Office skill file', 'missing-skill'],
    ['an empty runtime directory', 'empty-runtime'],
    ['an unusable primary runtime path', 'relative-source'],
  ] as const)('starts the Host with %s', async (_label, mode) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-office-'))
    let host: DesktopHostProcess | undefined
    const failures: Error[] = []
    try {
      const { project, paths } = await prepareDesktopHome(root)
      const runtime = join(root, 'runtime')
      mkdirSync(runtime)
      if (mode !== 'empty-runtime') {
        cpSync(join(repository, 'packages/skill/skill-office/assets'), join(runtime, 'office-skills'), { recursive: true })
        if (mode === 'missing-skill') rmSync(join(runtime, 'office-skills', 'office-docx', 'SKILL.md'))
      }
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      const primaryRuntime = mode === 'relative-source' ? 'runtime/primary-runtime' : join(runtime, 'primary-runtime')
      host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
        { ...process.env, ...desktopOfficeEnvironment(project, primaryRuntime) }, (error) => { failures.push(error) })
      const { url } = await host.start()
      // The authenticated URL exchanges its token for a session cookie by redirecting.
      const response = await fetch(url, { redirect: 'manual' })
      await response.body?.cancel()
      expect(response.status).toBe(303)
      expect(failures).toEqual([])
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
