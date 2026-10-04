/** Real Windows registry operations use a unique key tree rather than the user's environment. */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')('preserves unrelated PATH entries and rejects stale or foreign removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-command-path-'))
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    if (systemRoot === undefined) throw new Error('SystemRoot is required for the Windows registry test')
    const result = await promisify(execFile)(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(import.meta.dirname, 'fixtures', 'command-path.ps1'),
      '-Worker', join(import.meta.dirname, '..', 'scripts', 'command-path.ps1'), '-Root', root,
    ], { timeout: 60000, windowsHide: true })
    expect(result.stdout).toContain('WINDOWS_COMMAND_PATH_OK')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 75000)
