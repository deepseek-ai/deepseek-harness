import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { prepareWindowsBuildWorkspace, removeWindowsBuildWorkspace } from '../apps/desktop/scripts/windows-build-workspace.mjs'

it('clones the exact clean commit and removes only its run-owned checkout', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'package-workspace-')))
  try {
    const sourceDirectory = join(root, 'original')
    mkdirSync(sourceDirectory)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: sourceDirectory, encoding: 'utf8', stdio: 'pipe' }).trim()
    git('init')
    writeFileSync(join(sourceDirectory, 'source.txt'), 'selected source')
    writeFileSync(join(sourceDirectory, '.gitignore'), 'private.env\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
    writeFileSync(join(sourceDirectory, 'private.env'), 'ignored fixture')
    const options = { sourceDirectory, buildRoot: join(root, 'builds'), runId: '123', runAttempt: '1', sourceSha: git('rev-parse', 'HEAD') }
    expect(() => prepareWindowsBuildWorkspace({ ...options, buildRoot: sourceDirectory })).toThrow('outside existing Git')
    expect(() => prepareWindowsBuildWorkspace({ ...options, buildRoot: 'relative' })).toThrow('absolute')
    expect(() => prepareWindowsBuildWorkspace({ ...options, runId: '../other' })).toThrow('identity')
    expect(() => prepareWindowsBuildWorkspace({ ...options, sourceSha: '0'.repeat(40) })).toThrow('match')
    writeFileSync(join(sourceDirectory, 'source.txt'), 'dirty')
    expect(() => prepareWindowsBuildWorkspace(options)).toThrow('clean')
    writeFileSync(join(sourceDirectory, 'source.txt'), 'selected source')
    const output = join(root, 'actions-output')
    execFileSync(process.execPath, [resolve(import.meta.dirname, '../apps/desktop/scripts/windows-build-workspace.mjs')], {
      cwd: sourceDirectory,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: sourceDirectory,
        PACKAGE_BUILD_ROOT: options.buildRoot,
        GITHUB_RUN_ID: options.runId,
        GITHUB_RUN_ATTEMPT: options.runAttempt,
        PACKAGE_SOURCE_SHA: options.sourceSha,
        GITHUB_OUTPUT: output,
      },
      stdio: 'pipe',
    })
    const directory = join(options.buildRoot, 'windows-package-123-1', 'source')
    const temporaryDirectory = join(options.buildRoot, 'windows-package-123-1', 'temp')
    expect(readFileSync(output, 'utf8')).toBe(`directory=${directory}\ntemporaryDirectory=${temporaryDirectory}\n`)
    writeFileSync(join(temporaryDirectory, 'temporary.txt'), 'owned temporary data')
    expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('selected source')
    expect(existsSync(join(directory, 'private.env'))).toBe(false)
    expect(() => prepareWindowsBuildWorkspace(options)).toThrow()
    expect(() => { removeWindowsBuildWorkspace({ ...options, sourceSha: '0'.repeat(40) }) }).toThrow('ownership')
    expect(existsSync(directory)).toBe(true)
    const external = join(root, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'keep.txt'), 'keep')
    symlinkSync(external, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    removeWindowsBuildWorkspace(options)
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(temporaryDirectory)).toBe(false)
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readFileSync(join(sourceDirectory, 'source.txt'), 'utf8')).toBe('selected source')
    const linked = join(root, 'linked')
    symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => prepareWindowsBuildWorkspace({ ...options, buildRoot: join(linked, 'builds') })).toThrow('links')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
