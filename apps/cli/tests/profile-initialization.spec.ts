/** Custom-profile replacement from shipped templates. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initProfile,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { initializeProfileFromDefault } from '../src/profile-boot.ts'

/** Replaces one `renameSync` call when it returns true; the real rename runs otherwise. */
const renameHook = vi.hoisted(() => ({ current: undefined as ((from: string, to: string) => boolean) | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync(from: string, to: string): void {
      if (renameHook.current?.(from, to) !== true) fs.renameSync(from, to)
    },
  }
})

afterEach(() => {
  renameHook.current = undefined
})

/** A rename failure whose code does not identify a concurrent target. */
function renameFailure(): NodeJS.ErrnoException {
  return Object.assign(new Error('rename failed'), { code: 'EIO' })
}

const childEntry = fileURLToPath(new URL('./fixtures/initialize-profile-from-default.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx/esm')
const CHILD_TIMEOUT_MS = 30_000

/** Wait until a child has reached the shared creation barrier. */
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`profile initialization marker did not appear: ${file}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Run one assertion against a private Harness home and remove it afterwards. */
function withHome(assertion: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-from-default-'))
  try {
    assertion(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('initializeProfileFromDefault', () => {
  it.each(Object.entries(PROFILE_TEMPLATES))(
    'copies the %s template metadata into an independent profile',
    (source, template) => {
      withHome((home) => {
        initializeProfileFromDefault('custom', source, home)
        const dir = resolveProfileDir('custom', home)
        const manifest = readProfileManifest('test', dir)
        expect(manifest).toEqual({
          name: 'dsh-profile-custom',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [...template.bundles] } },
        })
        expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
        expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
      })
    },
  )

  it('does not copy the local source profile dependencies or user patch', () => {
    withHome((home) => {
      const sourceDir = resolveProfileDir('web', home)
      initProfile(sourceDir, ['local-bundle'])
      const sourceManifest = readProfileManifest('test', sourceDir)
      sourceManifest.dependencies = { 'local-bundle': '1.0.0' }
      writeProfileManifest(sourceDir, sourceManifest)
      writeFileSync(join(sourceDir, PROFILE_PATCH_FILENAME), '- id: local-only\n  disabled: true\n')

      initializeProfileFromDefault('rescue', 'web', home)

      const targetDir = resolveProfileDir('rescue', home)
      const target = readProfileManifest('test', targetDir)
      expect(target.dependencies).toEqual({})
      expect(target.dsh?.profile).toEqual({
        bundles: [...PROFILE_TEMPLATES.web!.bundles],
      })
      expect(readFileSync(join(targetDir, PROFILE_PATCH_FILENAME), 'utf8')).not.toContain('local-only')
    })
  })

  it('replaces an existing target with a fresh template copy', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      initProfile(dir, ['existing-bundle'])
      const manifest = readProfileManifest('test', dir)
      manifest.dependencies = { 'existing-bundle': '1.0.0' }
      writeProfileManifest(dir, manifest)
      writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: existing\n  disabled: true\n')
      mkdirSync(join(dir, 'node_modules', 'existing-bundle'), { recursive: true })

      initializeProfileFromDefault('rescue', 'web', home)

      expect(readProfileManifest('test', dir)).toEqual({
        name: 'dsh-profile-rescue',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...PROFILE_TEMPLATES.web!.bundles] } },
      })
      expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).not.toContain('existing')
      expect(existsSync(join(dir, 'node_modules'))).toBe(false)
      expect(readdirSync(dirname(dir))).toEqual(['rescue'])
    })
  })

  it('replaces a residual target directory', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'residual'), '')

      initializeProfileFromDefault('rescue', 'web', home)

      expect(existsSync(join(dir, 'residual'))).toBe(false)
      expect(readProfileManifest('test', dir).dsh?.profile).toEqual(PROFILE_TEMPLATES.web)
    })
  })

  it('restores the previous target when the fresh copy cannot be moved into place', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      initProfile(dir, ['existing-bundle'])
      const before = readFileSync(join(dir, 'package.json'))
      renameHook.current = (from, to) => {
        if (to === dir && from.endsWith(join('new', 'rescue'))) throw renameFailure()
        return false
      }

      expect(() => {
        initializeProfileFromDefault('rescue', 'web', home)
      }).toThrow('rename failed')
      expect(readFileSync(join(dir, 'package.json'))).toEqual(before)
      expect(readdirSync(dirname(dir))).toEqual(['rescue'])
    })
  })

  it('keeps the previous target in staging when restoring it also fails', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      initProfile(dir, ['existing-bundle'])
      const before = readFileSync(join(dir, 'package.json'))
      renameHook.current = (_from, to) => {
        if (to === dir) throw renameFailure()
        return false
      }

      let failure: unknown
      try {
        initializeProfileFromDefault('rescue', 'web', home)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(AggregateError)
      const [staging] = readdirSync(dirname(dir))
      expect(staging).toMatch(/^\.rescue\.staging-/)
      const previous = join(dirname(dir), staging!, 'previous')
      expect((failure as AggregateError).message).toContain(previous)
      expect(readFileSync(join(previous, 'package.json'))).toEqual(before)
    })
  })

  it('reports a target recreated between the two renames and keeps that copy', () => {
    withHome((home) => {
      const dir = resolveProfileDir('rescue', home)
      initProfile(dir, ['existing-bundle'])
      renameHook.current = (_from, to) => {
        if (to !== dir) return false
        renameHook.current = undefined
        initProfile(dir, ['concurrent-bundle'])
        // The real rename now fails with the platform's code for an occupied target.
        return false
      }

      expect(() => {
        initializeProfileFromDefault('rescue', 'web', home)
      }).toThrow('profile "rescue" was recreated concurrently')
      expect(readProfileManifest('test', dir).dsh?.profile).toEqual({ bundles: ['concurrent-bundle'] })
      expect(readdirSync(dirname(dir))).toEqual(['rescue'])
    })
  })

  it('rejects a case variant of a shipped profile without changing it', () => {
    withHome((home) => {
      const dir = resolveProfileDir('web', home)
      initProfile(dir, ['existing-bundle'])
      const before = readFileSync(join(dir, 'package.json'))

      expect(() => {
        initializeProfileFromDefault('Web', 'headless', home)
      }).toThrow('profile "Web" names shipped profile "web"')
      expect(readFileSync(join(dir, 'package.json'))).toEqual(before)
    })
  })

  it.each(Object.keys(PROFILE_TEMPLATES))('rejects shipped target name %s without creating it', (name) => {
    withHome((home) => {
      expect(() => {
        initializeProfileFromDefault(name, 'web', home)
      })
        .toThrow(`names shipped profile ${JSON.stringify(name)}`)
      expect(existsSync(resolveProfileDir(name, home))).toBe(false)
    })
  })

  it.each(['unknown', 'toString'])('rejects unknown template %s without creating the target', (source) => {
    withHome((home) => {
      expect(() => {
        initializeProfileFromDefault('rescue', source, home)
      })
        .toThrow(`unknown default profile ${JSON.stringify(source)}`)
      expect(existsSync(resolveProfileDir('rescue', home))).toBe(false)
    })
  })

  it('leaves one complete template copy after two synchronized processes replace the target', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-from-default-race-'))
    const gate = join(home, 'start')
    const ready = [join(home, 'ready-1'), join(home, 'ready-2')]
    const children = ready.map(marker => execa(
      process.execPath,
      ['--import', tsxLoader, childEntry, home, 'rescue', 'web', marker, gate],
      { reject: false, timeout: CHILD_TIMEOUT_MS },
    ))
    try {
      await Promise.all(ready.map(waitForFile))
      writeFileSync(gate, '')
      const results = await Promise.all(children)
      expect(results.map(result => result.exitCode)).toContain(0)
      for (const result of results.filter(result => result.exitCode !== 0)) {
        expect(result.stderr).toContain('was recreated concurrently')
      }
      const dir = resolveProfileDir('rescue', home)
      expect(readProfileManifest('test', dir).dsh?.profile).toEqual(PROFILE_TEMPLATES.web)
      expect(readdirSync(dirname(dir))).toEqual(['rescue'])
    } finally {
      for (const child of children) child.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  }, CHILD_TIMEOUT_MS + 10_000)
})
