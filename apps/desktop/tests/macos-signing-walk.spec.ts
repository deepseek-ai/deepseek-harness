/** Exercise the installed macOS signer against Framework file and directory aliases. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const builderRequire = createRequire(createRequire(import.meta.url).resolve('app-builder-lib'))
const { walkAsync } = builderRequire(join(dirname(builderRequire.resolve('@electron/osx-sign')), 'util.js')) as {
  walkAsync: (path: string) => Promise<string[]>
}

// macOS Framework aliases use POSIX file and directory symlinks, unavailable on unprivileged Windows runners.
it.skipIf(process.platform === 'win32')('signs each real Framework file once and retains nested bundle signing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-signing-walk-'))
  try {
    const contents = join(root, 'Contents')
    const framework = join(contents, 'Frameworks', 'Test.framework')
    const version = join(framework, 'Versions', 'A')
    const resource = join(version, 'Resources', 'en.lproj', 'locale.pak')
    const library = join(version, 'library.dylib')
    const helper = join(contents, 'Frameworks', 'Helper.app')
    const executable = join(helper, 'Contents', 'MacOS', 'helper')
    for (const file of [resource, library, executable]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
    }
    symlinkSync('A', join(framework, 'Versions', 'Current'))
    symlinkSync('Versions/Current/Resources', join(framework, 'Resources'))
    symlinkSync('Versions/Current/library.dylib', join(framework, 'library.dylib'))
    const files = await walkAsync(contents)
    expect(files.sort()).toEqual([resource, library, executable, framework, helper].sort())
    expect(new Set(files.map(file => realpathSync(file))).size).toBe(files.length)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
